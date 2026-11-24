// Jobs, claims and pause state live on disk, and both parts read them from here.
//
// The TUI does not talk to the server part over RPC on purpose: the files are
// already the shared truth (a claim has to be a file to work across instances),
// and reading them directly means the panel can never disagree with what the
// ticker is about to do.

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  catchUpText,
  describeSchedule,
  everyOf,
  nextFireAt,
  runKey,
  scheduleProblem,
  weekdayIndex,
  type Every,
  type Job,
} from "./schedule.ts";
import { wallClock } from "./tz.ts";

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

/**
 * Why the jobs file cannot be used, or null when it reads.
 *
 * A file that does not parse loads as no jobs, which looks exactly like an empty
 * schedule. This is what lets the log say which one it is.
 */
export function jobsFileProblem(file: string): string | null {
  if (!existsSync(file)) return `no jobs file at ${file}`;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(parsed?.jobs)) return `${file} has no "jobs" array`;
    return null;
  } catch (error) {
    return `${file} is not valid JSON (${(error as Error).message}); no job will run until it is fixed`;
  }
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
      ...job,
      // A hand-edited "" would make `Intl` throw everywhere it is used; empty means
      // "this machine's clock", which is what no field at all means.
      timezone: typeof job.timezone === "string" && job.timezone.trim() ? job.timezone.trim() : undefined,
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

/**
 * The claim for the latest scheduled time: `<id>-2027-01.json` for a monthly job,
 * `<id>-2027-01-15.json` for a daily or weekly one, `<id>-2027-01-15T09.json` for
 * an hourly one.
 *
 * The key comes from the job's own clock: a job in Tokyo claims January on the 31st
 * of December here, and a file named after the local month would let the same job
 * claim twice.
 */
export function claimFile(target: string, job: Job, now: Date): string {
  return path.join(runDir(target), `${runKey(job, now).replace("/", "-")}.json`);
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

/** How many claim files each job keeps. Only the latest is ever read. */
export const CLAIMS_KEPT = 10;

/**
 * Delete a job's old claims, keeping the newest few.
 *
 * Only the claim for the latest scheduled time decides anything; older ones are
 * history, and `history.jsonl` already has that. An hourly job would otherwise
 * leave close to nine thousand files a year.
 */
export function pruneClaims(target: string, jobID: string, keep = CLAIMS_KEPT): number {
  const dir = runDir(target);
  if (!existsSync(dir)) return 0;
  const escaped = jobID.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Anchored on the key's shape, so pruning "report" never touches "report-2".
  const pattern = new RegExp(`^${escaped}-(\\d{4}-\\d{2}(?:-\\d{2}(?:T\\d{2})?)?)\\.json$`);
  const claims = readdirSync(dir)
    .map((name) => ({ name, key: pattern.exec(name)?.[1] }))
    .filter((entry): entry is { name: string; key: string } => Boolean(entry.key))
    .sort((a, b) => b.key.localeCompare(a.key));
  let removed = 0;
  for (const { name } of claims.slice(keep)) {
    try {
      unlinkSync(path.join(dir, name));
      removed++;
    } catch {}
  }
  return removed;
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
  let soonestZone: string | undefined;
  for (const job of active) {
    const next = nextFireAt(job, now);
    if (next.getTime() < soonest) {
      soonest = next.getTime();
      soonestZone = job.timezone;
    }
  }
  const suffix = pausedCount ? ` · ${pausedCount} paused` : "";
  if (!Number.isFinite(soonest)) return `scheduled${suffix}`;
  return `next ${formatWhen(new Date(soonest), now, soonestZone)}${suffix}`;
}

export function formatWhen(date: Date, now = new Date(), timeZone?: string): string {
  const zone = timeZone || undefined;
  const a = wallClock(date, zone);
  const b = wallClock(now, zone);
  const sameDay = a.year === b.year && a.monthIndex === b.monthIndex && a.day === b.day;
  const time = date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: zone });
  if (sameDay) return `today ${time}`;
  return `${date.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: zone })} ${time}`;
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
  every: Every;
  /** "Mondays at 09:00", without the zone. */
  schedule: string;
  day?: number;
  weekday?: string;
  hour?: number;
  minute: number;
  timezone?: string;
  /** As it would be written: "0d", "6h", "30m". */
  catchUp: string;
  paused: boolean;
  /** Whether the latest scheduled time has run. */
  ranLatest: boolean;
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
    const next = paused ? null : nextFireAt(job, now);
    const sessions = sessionsFor(job, claim, history);
    const every = everyOf(job);
    return {
      id: job.id,
      label: job.label ?? job.id,
      every,
      schedule: describeSchedule(job),
      // Each frequency sends only the fields it uses, the same rule the file has.
      ...(every === "month" ? { day: job.day } : {}),
      ...(every === "week" ? { weekday: job.weekday } : {}),
      ...(every !== "hour" ? { hour: job.hour ?? 0 } : {}),
      minute: job.minute ?? 0,
      // Omitted rather than null when the job runs on the local clock, so the panel
      // has one thing to check instead of two.
      ...(job.timezone ? { timezone: job.timezone } : {}),
      catchUp: catchUpText(job),
      paused,
      ranLatest: Boolean(claim),
      nextAt: next ? next.toISOString() : null,
      // The newest run of any scheduled time, not only the latest one's claim: a
      // daily job that missed today still ran yesterday.
      lastRun: sessions[0]?.at ?? claim?.startedAt ?? null,
      lastSession: sessions[0]?.sessionID ?? claim?.sessionID ?? null,
      sessions,
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

/** Past this many lines the history is cut back to the newest HISTORY_KEPT. */
export const HISTORY_LIMIT = 2000;
export const HISTORY_KEPT = 1000;

/**
 * Append-only, one line per dispatch.
 *
 * Claims are pruned and get overwritten by a forced run, so they cannot answer
 * "what has this job run". This can, and it survives restarts without a schema.
 * It is trimmed rather than left to grow: an hourly job adds 8,760 lines a year,
 * and the panel only ever shows the newest 25 per job.
 */
export function recordRun(target: string, record: RunRecord): void {
  try {
    mkdirSync(runDir(target), { recursive: true });
    const file = historyFile(target);
    appendFileSync(file, `${JSON.stringify(record)}\n`);
    const lines = readFileSync(file, "utf8").split("\n").filter((line) => line.trim());
    if (lines.length > HISTORY_LIMIT) {
      // Same temp-and-rename as the jobs file, so a crash cannot truncate it.
      const temp = `${file}.tmp`;
      writeFileSync(temp, `${lines.slice(-HISTORY_KEPT).join("\n")}\n`);
      renameSync(temp, file);
    }
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
  every?: Every;
  day?: number;
  weekday?: string;
  hour?: number;
  minute?: number;
  timezone?: string;
  catchUp?: string;
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
 * The schedule fields are checked by `scheduleProblem`, which the ticker also runs
 * on hand-edited jobs. A prompt that does not exist is rejected here: it would
 * dispatch an empty message on schedule and look like it worked.
 */
export function validateJob(jobsPath: string, input: JobInput, existing: JobInput[] = []): string | null {
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(String(input.id ?? ""))) {
    return "id must be lower-case letters, digits and dashes, starting with a letter or digit";
  }
  if (existing.some((job) => job.id === input.id)) return `a job with id "${input.id}" already exists`;
  const problem = scheduleProblem(input as unknown as Record<string, unknown>);
  if (problem) return problem;
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
  // Tools and RPC callers send every property they have, often as undefined or "".
  // Drop those first, so "not given" is one thing and the file only holds fields
  // the job uses.
  const clean = Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined && value !== null && value !== ""),
  ) as unknown as JobInput;
  const problem = validateJob(jobsPath, clean, file.jobs);
  if (problem) return { ok: false, error: problem };
  // One spelling in the file, whatever the request said: "Monday" becomes "mon".
  if (clean.weekday !== undefined) clean.weekday = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][weekdayIndex(clean.weekday)];
  file.jobs.push(clean);
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
