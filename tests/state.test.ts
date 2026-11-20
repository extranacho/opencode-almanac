import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { addJob, formatWhen, loadJobs, nextRun, readJobFile, readPaused, removeJob, resolveJobsFile, setPaused, summarise } from "../state.ts";

const job = { id: "batch", day: 1, hour: 8, minute: 0, catchUpDays: 30, prompt: "" };

function at(year: number, month: number, day: number, hour = 12): Date {
  return new Date(year, month - 1, day, hour, 0, 0, 0);
}

describe("next run", () => {
  it("is this month while the day is still ahead", () => {
    expect(nextRun(job, at(2026, 12, 20))).toEqual(at(2027, 1, 1, 8));
  });

  it("rolls to next month once the day has passed", () => {
    expect(nextRun(job, at(2027, 1, 5))).toEqual(at(2027, 2, 1, 8));
  });

  it("rolls over when the month has already run", () => {
    // Claimed January, so the next fire is February even though today is the 1st.
    expect(nextRun(job, at(2027, 1, 1, 9), "batch/2027-01")).toEqual(at(2027, 2, 1, 8));
  });

  it("formats a same-day clock without the date", () => {
    expect(formatWhen(at(2027, 1, 1, 8), at(2027, 1, 1, 7))).toBe("today 08:00");
  });
});

describe("jobs file", () => {
  it("reads jobs and expands a prompt file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "almanac-"));
    mkdirSync(path.join(dir, "prompts"));
    writeFileSync(path.join(dir, "prompts", "batch.md"), "run it\n");
    writeFileSync(
      path.join(dir, "jobs.json"),
      JSON.stringify({ version: 1, jobs: [{ ...job, label: "Batch", promptFile: "prompts/batch.md" }] }),
    );
    const jobs = loadJobs(path.join(dir, "jobs.json"));
    expect(jobs).toHaveLength(1);
    expect(jobs[0].prompt).toBe("run it");
    expect(jobs[0].label).toBe("Batch");
    // Defaults are filled in so the panel never renders "undefined:undefined".
    expect(jobs[0].minute).toBe(0);
  });

  it("survives a missing or malformed file instead of taking the sidebar down", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "almanac-"));
    expect(loadJobs(path.join(dir, "jobs.json"))).toEqual([]);
    writeFileSync(path.join(dir, "jobs.json"), "{ not json");
    expect(loadJobs(path.join(dir, "jobs.json"))).toEqual([]);
  });
});

describe("pause state", () => {
  it("round-trips through the pause file", () => {
    const repo = mkdtempSync(path.join(tmpdir(), "almanac-repo-"));
    expect(readPaused(repo)).toEqual({});
    setPaused(repo, "batch", true);
    expect(readPaused(repo).batch.pausedAt).toBeTruthy();
    setPaused(repo, "batch", false);
    expect(readPaused(repo)).toEqual({});
  });

  it("says so in the sidebar line", () => {
    const repo = mkdtempSync(path.join(tmpdir(), "almanac-repo-"));
    setPaused(repo, "batch", true);
    expect(summarise(repo, [job], at(2027, 1, 5))).toBe("paused");
  });
});

describe("jobs file location", () => {
  it("resolves options.jobsFile against the repo, and falls back beside the plugin", () => {
    expect(resolveJobsFile("/plugin", "/repo", ".opencode/almanac/jobs.json")).toBe("/repo/.opencode/almanac/jobs.json");
    expect(resolveJobsFile("/plugin", "/repo", "/abs/jobs.json")).toBe("/abs/jobs.json");
    expect(resolveJobsFile("/plugin", "/repo")).toBe("/plugin/jobs.json");
  });

  it("resolves promptFile relative to the jobs file, not the plugin", () => {
    const repo = mkdtempSync(path.join(tmpdir(), "almanac-repo-"));
    mkdirSync(path.join(repo, ".opencode/almanac/prompts"), { recursive: true });
    writeFileSync(path.join(repo, ".opencode/almanac/prompts/run.md"), "from the repo\n");
    writeFileSync(
      path.join(repo, ".opencode/almanac/jobs.json"),
      JSON.stringify({ version: 1, jobs: [{ ...job, promptFile: "prompts/run.md" }] }),
    );
    const loaded = loadJobs(path.join(repo, ".opencode/almanac/jobs.json"));
    expect(loaded[0].prompt).toBe("from the repo");
  });
});

describe("adding and removing jobs", () => {
  const base = { id: "report", day: 15, hour: 9 } as const;

  function fresh(): string {
    const repo = mkdtempSync(path.join(tmpdir(), "almanac-repo-"));
    mkdirSync(path.join(repo, ".opencode/almanac"), { recursive: true });
    writeFileSync(path.join(repo, ".opencode/almanac/jobs.json"), JSON.stringify({ version: 1, jobs: [] }));
    return path.join(repo, ".opencode/almanac/jobs.json");
  }

  it("round-trips through the file and refuses duplicates", () => {
    const file = fresh();
    expect(addJob(file, { ...base, prompt: "do it" })).toEqual({ ok: true, jobs: 1 });
    expect(readJobFile(file).jobs[0].id).toBe("report");
    const again = addJob(file, { ...base, prompt: "do it" });
    expect(again.ok).toBe(false);
    expect(removeJob(file, "report").ok).toBe(true);
    expect(readJobFile(file).jobs).toHaveLength(0);
  });

  it("accepts 31, which clamps, and refuses 32", () => {
    const file = fresh();
    expect(addJob(file, { ...base, id: "end", day: 31, prompt: "x" }).ok).toBe(true);
    const tooBig = addJob(file, { ...base, id: "big", day: 32, prompt: "x" });
    expect(tooBig.ok).toBe(false);
    if (!tooBig.ok) expect(tooBig.error).toContain("1 to 31");
  });

  it("refuses a promptFile that does not exist", () => {
    const file = fresh();
    const result = addJob(file, { ...base, promptFile: "prompts/missing.md" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("not found");
  });

  it("accepts a promptFile that exists beside the jobs file", () => {
    const file = fresh();
    mkdirSync(path.join(path.dirname(file), "prompts"), { recursive: true });
    writeFileSync(path.join(path.dirname(file), "prompts", "run.md"), "go\n");
    expect(addJob(file, { ...base, promptFile: "prompts/run.md" }).ok).toBe(true);
    expect(loadJobs(file)[0].prompt).toBe("go");
  });

  it("reports a missing id on remove instead of writing", () => {
    const file = fresh();
    const result = removeJob(file, "nope");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("no job with id");
  });

  it("rejects an id that is not a slug", () => {
    const file = fresh();
    expect(addJob(file, { ...base, id: "Bad Id", prompt: "x" }).ok).toBe(false);
  });
});

describe("next run with a clamped day", () => {
  it("takes April's 31st to the 30th", () => {
    expect(nextRun({ id: "end", day: 31, hour: 8, minute: 0, catchUpDays: 0, prompt: "" }, at(2027, 4, 29))).toEqual(
      at(2027, 4, 30, 8),
    );
  });

  it("takes February's 29th to the 28th outside a leap year, and keeps it in one", () => {
    const job29 = { id: "end", day: 29, hour: 8, minute: 0, catchUpDays: 0, prompt: "" };
    expect(nextRun(job29, at(2027, 2, 10))).toEqual(at(2027, 2, 28, 8));
    expect(nextRun(job29, at(2028, 2, 10))).toEqual(at(2028, 2, 29, 8));
  });
});
