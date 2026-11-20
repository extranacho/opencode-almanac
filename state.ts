// Jobs, claims and pause state live on disk, and both parts read them from here.
//
// The TUI does not talk to the server part over RPC on purpose: the files are
// already the shared truth (a claim has to be a file to work across instances),
// and reading them directly means the panel can never disagree with what the
// ticker is about to do. The cost is a poll interval, which for a monthly
// scheduler is not a cost at all.

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { monthKey, type Job } from "./schedule.ts";

/** As written in jobs.json: a prompt inline, or a file beside it. */
export interface JobConfig extends Job {
  label?: string;
  promptFile?: string;
}

export interface Claim {
  startedAt?: string;
  sessionID?: string;
  ok?: boolean;
}

/**
 * Where the jobs file lives.
 *
 * A shared plugin must not carry anyone's schedule, so `options.jobsFile` names it,
 * relative to `options.repo`. Without the option this falls back to `jobs.json`
 * beside the plugin, which is only useful while developing it.
 */
export function resolveJobsFile(pluginDir: string, repo: string, jobsFile?: string): string {
  if (!jobsFile) return path.join(pluginDir, "jobs.json");
  return path.isAbsolute(jobsFile) ? jobsFile : path.join(repo, jobsFile);
}

export function loadJobs(file: string): JobConfig[] {
  if (!existsSync(file)) return [];
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return [];
  }
  const jobs = Array.isArray(parsed?.jobs) ? parsed.jobs : [];
  return jobs
    .filter((job) => job && typeof job.id === "string")
    .map((job) => ({
      minute: 0,
      catchUpDays: 0,
      ...job,
      // Relative to the jobs file, so a user's prompts live beside their schedule
      // in their own repo rather than inside a package that gets replaced on update.
      prompt: job.promptFile
        ? readText(path.join(path.dirname(file), job.promptFile)) ?? ""
        : String(job.prompt ?? ""),
    }));
}

export function runDir(target: string): string {
  return path.join(target, ".run", "almanac");
}

export function claimFile(target: string, job: Job, now: Date): string {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  return path.join(runDir(target), `${job.id}-${now.getFullYear()}-${month}.json`);
}

export function readClaim(target: string, job: Job, now: Date): Claim | null {
  const file = claimFile(target, job, now);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Claim;
  } catch {
    return null;
  }
}

/** Every claim on disk, newest month first. Used by the panel's history line. */
export function allClaims(target: string): Array<{ id: string; month: string; claim: Claim }> {
  const dir = runDir(target);
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json") || name === "paused.json") continue;
    const match = name.match(/^(.+)-(\d{4}-\d{2})\.json$/);
    if (!match) continue;
    try {
      out.push({ id: match[1], month: match[2], claim: JSON.parse(readFileSync(path.join(dir, name), "utf8")) });
    } catch {}
  }
  return out.sort((a, b) => b.month.localeCompare(a.month));
}

type PausedMap = Record<string, { pausedAt: string }>;

export function readPaused(target: string): PausedMap {
  const file = path.join(runDir(target), "paused.json");
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as PausedMap) : {};
  } catch {
    return {};
  }
}

export function isPaused(target: string, jobID: string): boolean {
  return Boolean(readPaused(target)[jobID]);
}

export function setPaused(target: string, jobID: string, paused: boolean): void {
  const file = path.join(runDir(target), "paused.json");
  mkdirSync(runDir(target), { recursive: true });
  const map = readPaused(target);
  if (paused) map[jobID] = { pausedAt: new Date().toISOString() };
  else delete map[jobID];
  writeFileSync(file, `${JSON.stringify(map, null, 2)}\n`);
}

/**
 * `run now` writes a marker and the ticker picks it up within a tick.
 *
 * The panel could create the session itself through the client, but then two
 * code paths would dispatch and only one of them would write the claim. One
 * dispatcher is worth a short wait, so the panel says so.
 */
export function forceFile(target: string, jobID: string): string {
  return path.join(runDir(target), "force", jobID);
}

export function requestRun(target: string, jobID: string): void {
  const file = forceFile(target, jobID);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, new Date().toISOString());
}

export function consumeRunRequest(target: string, jobID: string): boolean {
  const file = forceFile(target, jobID);
  if (!existsSync(file)) return false;
  try {
    unlinkSync(file);
  } catch {}
  return true;
}

/** One-line state for the sidebar: what the next run is, and anything paused. */
export function summarise(target: string, jobs: JobConfig[], now = new Date()): string {
  if (!jobs.length) return "no jobs";
  const paused = readPaused(target);
  const pausedCount = jobs.filter((job) => paused[job.id]).length;
  if (pausedCount === jobs.length) return "paused";

  const active = jobs.filter((job) => !paused[job.id]);
  let soonest = Infinity;
  for (const job of active) {
    const claim = readClaim(target, job, now);
    const next = nextRun(job, now, claim ? monthKey(job, now) : undefined);
    if (next && next.getTime() < soonest) soonest = next.getTime();
  }
  const suffix = pausedCount ? ` · ${pausedCount} paused` : "";
  if (!Number.isFinite(soonest)) return `scheduled${suffix}`;
  return `next ${formatWhen(new Date(soonest), now)}${suffix}`;
}

/** The next moment this job could fire, given whether this month already ran. */
export function nextRun(job: Job, now: Date, lastRun?: string): Date | null {
  const month = lastRun ? now.getMonth() + 1 : now.getMonth();
  for (let i = 0; i < 2; i++) {
    const candidate = new Date(now.getFullYear(), month + i, job.day, job.hour ?? 0, job.minute ?? 0, 0, 0);
    if (candidate.getTime() > now.getTime()) return candidate;
  }
  return null;
}

export function formatWhen(date: Date, now = new Date()): string {
  const sameDay = date.toDateString() === now.toDateString();
  const time = date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  if (sameDay) return `today ${time}`;
  return `${date.toLocaleDateString("en-GB", { day: "numeric", month: "short" })} ${time}`;
}

function readText(file: string): string | null {
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    return null;
  }
}

/** The shape the GUI renders, and the RPC returns. */
export interface JobView {
  id: string;
  label: string;
  day: number;
  hour: number;
  minute: number;
  catchUpDays: number;
  paused: boolean;
  ranThisMonth: boolean;
  nextAt: string | null;
  lastRun: string | null;
  lastSession: string | null;
  sessions: Array<{ sessionID: string; at: string; reason: string }>;
}

/** One view of every job, from the same files the ticker reads. */
export function describeJobs(target: string, jobs: JobConfig[], now = new Date()): JobView[] {
  const history = readHistory(target);
  return jobs.map((job) => {
    const paused = isPaused(target, job.id);
    const claim = readClaim(target, job, now);
    const next = paused ? null : nextRun(job, now, claim ? monthKey(job, now) : undefined);
    return {
      id: job.id,
      label: job.label ?? job.id,
      day: job.day,
      hour: job.hour ?? 0,
      minute: job.minute ?? 0,
      catchUpDays: job.catchUpDays ?? 0,
      paused,
      ranThisMonth: Boolean(claim),
      nextAt: next ? next.toISOString() : null,
      lastRun: claim?.startedAt ?? null,
      lastSession: claim?.sessionID ?? null,
      sessions: sessionsFor(job, claim, history),
    };
  });
}

/** One dispatch, kept so the panel can list what a job has already run. */
export interface RunRecord {
  jobID: string;
  sessionID: string;
  at: string;
  month: string;
  reason: string;
}

export function historyFile(target: string): string {
  return path.join(runDir(target), "history.jsonl");
}

/**
 * Append-only, one line per dispatch.
 *
 * Claims are per month and get overwritten by a forced run, so they cannot answer
 * "what has this job run". This can, and it survives restarts without a schema.
 */
export function recordRun(target: string, record: RunRecord): void {
  try {
    mkdirSync(runDir(target), { recursive: true });
    appendFileSync(historyFile(target), `${JSON.stringify(record)}\n`);
  } catch {}
}

/** Newest first. Unparseable lines are skipped rather than losing the list. */
export function readHistory(target: string): RunRecord[] {
  const file = historyFile(target);
  if (!existsSync(file)) return [];
  const out: RunRecord[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as RunRecord;
      if (parsed?.sessionID) out.push(parsed);
    } catch {}
  }
  return out.sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""));
}

/**
 * What the row shows under "Sessions".
 *
 * History is the record, but a job that ran before history existed still has a
 * claim, so the claim is folded in when its session is not already listed.
 */
function sessionsFor(
  job: JobConfig,
  claim: Claim | null,
  history: RunRecord[],
): Array<{ sessionID: string; at: string; reason: string }> {
  const seen = new Set<string>();
  const out: Array<{ sessionID: string; at: string; reason: string }> = [];
  for (const run of history) {
    if (run.jobID !== job.id || !run.sessionID || seen.has(run.sessionID)) continue;
    seen.add(run.sessionID);
    out.push({ sessionID: run.sessionID, at: run.at ?? "", reason: run.reason ?? "scheduled" });
  }
  if (claim?.sessionID && !seen.has(claim.sessionID)) {
    out.push({ sessionID: claim.sessionID, at: claim.startedAt ?? "", reason: "scheduled" });
  }
  return out.slice(0, 25);
}

/** The file as written, before prompts are expanded. */
export interface JobFile {
  version: number;
  jobs: JobInput[];
}

export interface JobInput {
  id: string;
  label?: string;
  day: number;
  hour: number;
  minute?: number;
  catchUpDays?: number;
  agent?: string;
  promptFile?: string;
  prompt?: string;
}

export function readJobFile(jobsPath: string): JobFile {
  if (!existsSync(jobsPath)) return { version: 1, jobs: [] };
  const parsed = JSON.parse(readFileSync(jobsPath, "utf8")) as JobFile;
  return { version: parsed?.version ?? 1, jobs: Array.isArray(parsed?.jobs) ? parsed.jobs : [] };
}

/**
 * Why a job would be rejected, or null when it is fine.
 *
 * `day` stops at 28 because no month is guaranteed to have a 29th; a job on the
 * 31st would fire in some months and silently skip others, which is worse than
 * refusing it. A prompt that does not exist is rejected for the same reason: it
 * would dispatch an empty message once a month and look like it worked.
 */
export function validateJob(jobsPath: string, input: JobInput, existing: JobInput[] = []): string | null {
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(String(input.id ?? ""))) {
    return "id must be lower-case letters, digits and dashes, starting with a letter or digit";
  }
  if (existing.some((job) => job.id === input.id)) return `a job with id "${input.id}" already exists`;
  if (!Number.isInteger(input.day) || input.day < 1 || input.day > 28) {
    return "day must be a whole number from 1 to 28 — no month is guaranteed to have a 29th";
  }
  if (!Number.isInteger(input.hour) || input.hour < 0 || input.hour > 23) return "hour must be 0 to 23";
  if (input.minute !== undefined && (!Number.isInteger(input.minute) || input.minute < 0 || input.minute > 59)) {
    return "minute must be 0 to 59";
  }
  if (input.catchUpDays !== undefined && (!Number.isInteger(input.catchUpDays) || input.catchUpDays < 0 || input.catchUpDays > 31)) {
    return "catchUpDays must be a whole number from 0 to 31";
  }
  if (!input.prompt && !input.promptFile) return "give either a prompt string or a promptFile";
  if (input.promptFile) {
    const file = path.isAbsolute(input.promptFile) ? input.promptFile : path.join(path.dirname(jobsPath), input.promptFile);
    if (!existsSync(file)) return `promptFile not found: ${input.promptFile}`;
  }
  return null;
}

function writeJobFile(jobsPath: string, file: JobFile): void {
  mkdirSync(path.dirname(jobsPath), { recursive: true });
  // Write beside the file and rename, so a crash mid-write cannot leave a schedule
  // that fails to parse — which would read as "no jobs" and stop the ticker.
  const temp = `${jobsPath}.tmp`;
  writeFileSync(temp, `${JSON.stringify(file, null, 2)}\n`);
  renameSync(temp, jobsPath);
}

export function addJob(jobsPath: string, input: JobInput): { ok: true; jobs: number } | { ok: false; error: string } {
  const file = readJobFile(jobsPath);
  const problem = validateJob(jobsPath, input, file.jobs);
  if (problem) return { ok: false, error: problem };
  file.jobs.push(input);
  writeJobFile(jobsPath, file);
  return { ok: true, jobs: file.jobs.length };
}

export function removeJob(jobsPath: string, id: string): { ok: boolean; error?: string; jobs?: number } {
  const file = readJobFile(jobsPath);
  const next = file.jobs.filter((job) => job.id !== id);
  if (next.length === file.jobs.length) return { ok: false, error: `no job with id "${id}"` };
  writeJobFile(jobsPath, { ...file, jobs: next });
  return { ok: true, jobs: next.length };
}
