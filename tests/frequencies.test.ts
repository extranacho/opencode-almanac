import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describeSchedule, evaluate, nextFireAt, runKey, scheduleProblem, type Job } from "../schedule.ts";
import {
  CLAIMS_KEPT,
  HISTORY_KEPT,
  HISTORY_LIMIT,
  addJob,
  describeJobs,
  historyFile,
  jobsFileProblem,
  pruneClaims,
  readJobFile,
  recordRun,
  runDir,
} from "../state.ts";

/** Local-time date, because a job without a timezone runs on the machine clock. */
function at(year: number, month: number, day: number, hour = 12, minute = 0): Date {
  return new Date(year, month - 1, day, hour, minute, 0, 0);
}

const utc = (year: number, month: number, day: number, hour = 12, minute = 0) =>
  new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0));

// 2027-01-04 is a Monday.
const weekly: Job = { id: "standup", every: "week", weekday: "mon", hour: 9, minute: 0, prompt: "" };
const daily: Job = { id: "digest", every: "day", hour: 7, minute: 30, prompt: "" };
const hourly: Job = { id: "sync", every: "hour", minute: 15, prompt: "" };

describe("weekly jobs", () => {
  it("fire on their weekday at the time, and not before", () => {
    expect(evaluate(weekly, at(2027, 1, 4, 8, 59), undefined).due).toBe(false);
    expect(evaluate(weekly, at(2027, 1, 4, 8, 59), undefined).reason).toBe("waiting for 09:00");
    expect(evaluate(weekly, at(2027, 1, 4, 9, 0), undefined).due).toBe(true);
    expect(evaluate(weekly, at(2027, 1, 4, 9, 0), undefined).reason).toBe("due");
  });

  it("are keyed by the date they were scheduled for", () => {
    expect(runKey(weekly, at(2027, 1, 4, 9))).toBe("standup/2027-01-04");
    // Wednesday still belongs to Monday's run.
    expect(runKey(weekly, at(2027, 1, 6))).toBe("standup/2027-01-04");
    // And Monday before 09:00 still belongs to the previous Monday's.
    expect(runKey(weekly, at(2027, 1, 4, 8))).toBe("standup/2026-12-28");
  });

  it("run once, then wait a week", () => {
    const claimed = runKey(weekly, at(2027, 1, 4, 9));
    expect(evaluate(weekly, at(2027, 1, 4, 10), claimed).due).toBe(false);
    expect(nextFireAt(weekly, at(2027, 1, 4, 10))).toEqual(at(2027, 1, 11, 9));
    expect(nextFireAt(weekly, at(2027, 1, 7))).toEqual(at(2027, 1, 11, 9));
  });

  it("only have the rest of the day unless catchUp says otherwise", () => {
    expect(evaluate(weekly, at(2027, 1, 4, 23, 59), undefined).due).toBe(true);
    expect(evaluate(weekly, at(2027, 1, 5, 0, 0), undefined).due).toBe(false);
    const lenient = { ...weekly, catchUp: "2d" };
    expect(evaluate(lenient, at(2027, 1, 6, 23), undefined).reason).toBe("late, catching up from Mon 4 Jan 09:00");
    expect(evaluate(lenient, at(2027, 1, 7, 0), undefined).due).toBe(false);
  });

  it("catch up across the end of the week", () => {
    // A Sunday job with a day of catch-up still runs on Monday, the next week.
    const sunday: Job = { ...weekly, weekday: "sunday", catchUp: "1d" };
    expect(evaluate(sunday, at(2027, 1, 4, 10), undefined).due).toBe(true);
    expect(runKey(sunday, at(2027, 1, 4, 10))).toBe("standup/2027-01-03");
  });
});

describe("daily jobs", () => {
  it("fire every day at the time", () => {
    expect(evaluate(daily, at(2027, 1, 15, 7, 29), undefined).due).toBe(false);
    expect(evaluate(daily, at(2027, 1, 15, 7, 30), undefined).due).toBe(true);
    expect(runKey(daily, at(2027, 1, 15, 7, 30))).toBe("digest/2027-01-15");
    expect(runKey(daily, at(2027, 1, 15, 7, 29))).toBe("digest/2027-01-14");
  });

  it("wait for tomorrow once today has run", () => {
    const decision = evaluate(daily, at(2027, 1, 15, 9), "digest/2027-01-15");
    expect(decision.due).toBe(false);
    expect(decision.reason).toBe("already ran for 2027-01-15; next 16 Jan 07:30");
    expect(nextFireAt(daily, at(2027, 1, 15, 9))).toEqual(at(2027, 1, 16, 7, 30));
  });

  it("catch up past midnight when the window allows it", () => {
    // 23:00 with "3h" runs until the end of 02:00, the next morning.
    const late: Job = { ...daily, hour: 23, minute: 0, catchUp: "3h" };
    expect(evaluate(late, at(2027, 1, 16, 2, 59), undefined).due).toBe(true);
    expect(runKey(late, at(2027, 1, 16, 2, 59))).toBe("digest/2027-01-15");
    expect(evaluate(late, at(2027, 1, 16, 3, 0), undefined).due).toBe(false);
  });

  it("keep 08:00 at 08:00 across a daylight-saving change", () => {
    const lisbon: Job = { ...daily, hour: 8, minute: 0, timezone: "Europe/Lisbon" };
    // Lisbon moves to UTC+1 on 28 March 2027.
    expect(nextFireAt(lisbon, utc(2027, 3, 27, 9)).toISOString()).toBe("2027-03-28T07:00:00.000Z");
    expect(nextFireAt(lisbon, utc(2027, 3, 26, 9)).toISOString()).toBe("2027-03-27T08:00:00.000Z");
  });

  it("read the date on their own clock", () => {
    const tokyo: Job = { ...daily, hour: 8, minute: 0, timezone: "Asia/Tokyo" };
    // 23:00 UTC on 14 Jan is 08:00 on the 15th in Tokyo.
    expect(evaluate(tokyo, utc(2027, 1, 14, 23), undefined).due).toBe(true);
    expect(runKey(tokyo, utc(2027, 1, 14, 23))).toBe("digest/2027-01-15");
  });
});

describe("hourly jobs", () => {
  it("fire every hour at the minute", () => {
    expect(evaluate(hourly, at(2027, 1, 15, 10, 14), undefined).reason).toBe("waiting for 10:15");
    expect(evaluate(hourly, at(2027, 1, 15, 10, 15), undefined).due).toBe(true);
    expect(runKey(hourly, at(2027, 1, 15, 10, 15))).toBe("sync/2027-01-15T10");
    expect(nextFireAt(hourly, at(2027, 1, 15, 10, 15))).toEqual(at(2027, 1, 15, 11, 15));
  });

  it("have the rest of that hour by default, and an exact window in minutes", () => {
    expect(evaluate(hourly, at(2027, 1, 15, 10, 59), undefined).due).toBe(true);
    const strict: Job = { ...hourly, catchUp: "30m" };
    expect(evaluate(strict, at(2027, 1, 15, 10, 45), undefined).due).toBe(true);
    expect(evaluate(strict, at(2027, 1, 15, 10, 46), undefined).due).toBe(false);
  });

  it("roll over midnight", () => {
    expect(runKey(hourly, at(2027, 1, 16, 0, 20))).toBe("sync/2027-01-16T00");
    expect(runKey(hourly, at(2027, 1, 16, 0, 10))).toBe("sync/2027-01-15T23");
  });
});

describe("monthly jobs keep working as before", () => {
  it("read catchUpDays, the old spelling", () => {
    const legacy: Job = { id: "batch", day: 1, hour: 8, catchUpDays: 3, prompt: "" };
    expect(evaluate(legacy, at(2027, 1, 4, 20), undefined).due).toBe(true);
    expect(evaluate(legacy, at(2027, 1, 5, 0), undefined).due).toBe(false);
  });

  it("can now catch up into the next month", () => {
    const endOfMonth: Job = { id: "close", day: 31, hour: 8, catchUp: "2d", prompt: "" };
    expect(evaluate(endOfMonth, at(2027, 2, 2, 12), undefined).due).toBe(true);
    // It is January's run, so February's 28th still fires on its own.
    expect(runKey(endOfMonth, at(2027, 2, 2, 12))).toBe("close/2027-01");
    expect(nextFireAt(endOfMonth, at(2027, 2, 2, 12))).toEqual(at(2027, 2, 28, 8));
  });
});

describe("describing a schedule", () => {
  it("says it the way a person would", () => {
    expect(describeSchedule(weekly)).toBe("Mondays at 09:00");
    expect(describeSchedule(daily)).toBe("daily at 07:30");
    expect(describeSchedule(hourly)).toBe("hourly at :15");
    expect(describeSchedule({ id: "x", day: 31, hour: 8, prompt: "" })).toBe("day 31 (or last) at 08:00");
  });
});

describe("schedule validation", () => {
  const ok = (job: Record<string, unknown>) => expect(scheduleProblem(job)).toBeNull();
  const refused = (job: Record<string, unknown>, words: string) => expect(scheduleProblem(job)).toContain(words);

  it("accepts each frequency with its own fields", () => {
    ok({ day: 15, hour: 9 });
    ok({ every: "week", weekday: "fri", hour: 17, minute: 30 });
    ok({ every: "week", weekday: "Friday", hour: 17 });
    ok({ every: "day", hour: 7 });
    ok({ every: "hour", minute: 0 });
    ok({ every: "hour" });
  });

  it("refuses a field the frequency does not use, rather than ignoring it", () => {
    refused({ every: "week", weekday: "mon", day: 15, hour: 9 }, "day is for monthly jobs");
    refused({ day: 15, weekday: "mon", hour: 9 }, "weekday is for weekly jobs");
    refused({ every: "day", day: 1, hour: 9 }, "a daily job runs every day");
    refused({ every: "hour", hour: 9, minute: 0 }, "drop day, weekday and hour");
  });

  it("names what is missing", () => {
    refused({ every: "week", hour: 9 }, "needs weekday");
    refused({ every: "week", weekday: "funday", hour: 9 }, "needs weekday");
    refused({ every: "day" }, "hour must be");
    refused({ hour: 9 }, "a monthly job needs day");
    refused({ every: "fortnight", hour: 9 }, "every must be");
  });

  it("keeps catch-up shorter than the gap between runs", () => {
    ok({ every: "hour", catchUp: "59m" });
    ok({ every: "hour", catchUp: "0h" });
    refused({ every: "hour", catchUp: "1h" }, "under an hour");
    ok({ every: "day", hour: 9, catchUp: "23h" });
    refused({ every: "day", hour: 9, catchUp: "1d" }, "under a day");
    ok({ every: "week", weekday: "mon", hour: 9, catchUp: "6d" });
    refused({ every: "week", weekday: "mon", hour: 9, catchUp: "7d" }, "under a week");
    ok({ day: 1, hour: 9, catchUp: "31d" });
    refused({ day: 1, hour: 9, catchUp: "32d" }, "at most a month");
  });

  it("refuses a catch-up it cannot read or that could miss the run", () => {
    refused({ day: 1, hour: 9, catchUp: "2 days" }, 'like "30m"');
    refused({ every: "hour", catchUp: "0m" }, "could miss the run");
    refused({ day: 1, hour: 9, catchUp: "1d", catchUpDays: 1 }, "not both");
    refused({ every: "day", hour: 9, catchUpDays: 1 }, "under a day");
  });
});

describe("adding jobs of each frequency", () => {
  function fresh(): string {
    const repo = mkdtempSync(path.join(tmpdir(), "almanac-repo-"));
    mkdirSync(path.join(repo, ".opencode/almanac"), { recursive: true });
    const file = path.join(repo, ".opencode/almanac/jobs.json");
    writeFileSync(file, JSON.stringify({ version: 1, jobs: [] }));
    return file;
  }

  it("writes one spelling of the weekday, and only the fields that were given", () => {
    const file = fresh();
    const result = addJob(file, {
      id: "standup",
      every: "week",
      weekday: "Monday",
      hour: 9,
      // What a tool call sends for fields the agent left out.
      day: undefined,
      timezone: "",
      prompt: "go",
    });
    expect(result.ok).toBe(true);
    expect(readJobFile(file).jobs[0]).toEqual({ id: "standup", every: "week", weekday: "mon", hour: 9, prompt: "go" });
  });

  it("refuses a weekly job with a day of the month", () => {
    const result = addJob(fresh(), { id: "w", every: "week", weekday: "mon", day: 15, hour: 9, prompt: "go" });
    expect(result.ok).toBe(false);
  });

  it("describes them for the panel", () => {
    const file = fresh();
    addJob(file, { id: "sync", every: "hour", minute: 15, prompt: "go" });
    const repo = path.dirname(path.dirname(path.dirname(file)));
    const [view] = describeJobs(repo, readJobFile(file).jobs as never, at(2027, 1, 15, 10, 20));
    expect(view.schedule).toBe("hourly at :15");
    expect(view.catchUp).toBe("0h");
    expect(view.hour).toBeUndefined();
    expect(view.day).toBeUndefined();
  });
});

describe("clean-up for frequent jobs", () => {
  it("keeps only the newest claims, and never another job's", () => {
    const repo = mkdtempSync(path.join(tmpdir(), "almanac-repo-"));
    const dir = runDir(repo);
    mkdirSync(dir, { recursive: true });
    for (let hour = 0; hour < 24; hour++) {
      writeFileSync(path.join(dir, `sync-2027-01-15T${String(hour).padStart(2, "0")}.json`), "{}");
    }
    writeFileSync(path.join(dir, "sync-2-2027-01.json"), "{}");
    writeFileSync(path.join(dir, "paused.json"), "{}");

    expect(pruneClaims(repo, "sync")).toBe(24 - CLAIMS_KEPT);
    const left = readdirSync(dir);
    expect(left).toContain("sync-2027-01-15T23.json");
    expect(left).not.toContain("sync-2027-01-15T00.json");
    expect(left).toContain("sync-2-2027-01.json");
    expect(left).toContain("paused.json");
  });

  it("trims the run history once it grows past the limit", () => {
    const repo = mkdtempSync(path.join(tmpdir(), "almanac-repo-"));
    mkdirSync(runDir(repo), { recursive: true });
    const line = (i: number) => JSON.stringify({ jobID: "sync", sessionID: `s${i}`, at: String(i), month: "", reason: "" });
    writeFileSync(historyFile(repo), `${Array.from({ length: HISTORY_LIMIT }, (_, i) => line(i)).join("\n")}\n`);
    recordRun(repo, { jobID: "sync", sessionID: "newest", at: "x", month: "", reason: "due" });
    const lines = readFileSync(historyFile(repo), "utf8").trim().split("\n");
    expect(lines).toHaveLength(HISTORY_KEPT);
    expect(lines.at(-1)).toContain("newest");
  });
});

describe("a jobs file that does not parse", () => {
  it("is reported rather than read as an empty schedule", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "almanac-"));
    const file = path.join(dir, "jobs.json");
    expect(jobsFileProblem(file)).toContain("no jobs file");
    writeFileSync(file, '{ "jobs": [ { "id": "a", } ] }');
    expect(jobsFileProblem(file)).toContain("not valid JSON");
    writeFileSync(file, '{ "jobs": [] }');
    expect(jobsFileProblem(file)).toBeNull();
    expect(existsSync(file)).toBe(true);
  });
});
