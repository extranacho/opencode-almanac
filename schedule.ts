// When a scheduled job is due. Pure, so it can be tested without the OpenCode server —
// this is the part that decides whether the batch runs at all, and the only part
// worth being paranoid about.
//
// One rule covers every frequency. A job has a series of scheduled times — the 1st
// at 08:00 each month, every Monday at 09:00, every day at 07:30, every hour at :15.
// At any instant the one that matters is the most recent scheduled time at or
// before now. It is due when it has not run yet and its catch-up window is still
// open. Each scheduled time has its own key, which is what the claim file is named
// after, so it runs once.
//
// Because the key belongs to the scheduled time rather than to the calendar period
// now falls in, a late run can cross a boundary: a job on the 31st with two days of
// catch-up still runs on the 2nd, and a daily job at 23:00 with "3h" still runs at
// 01:00.
//
// All arithmetic is on the job's wall clock, held as "wall time": the clock's fields
// read as if they were UTC. There is no daylight saving in that space, so adding a
// day is adding a day. Only the final "when is that, really" step goes through
// `zonedTime`.

import { hhmm, isValidTimeZone, wallClock, zonedTime } from "./tz.ts";

export type Every = "month" | "week" | "day" | "hour";
export const FREQUENCIES: readonly Every[] = ["month", "week", "day", "hour"];

/** Index matches `Date.getUTCDay()`: 0 is Sunday. */
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

export interface Job {
  id: string;
  /** How often it runs. Absent means monthly, which is all almanac did before 0.5. */
  every?: Every;
  /** Monthly only. Day of the month, 1-31. 29-31 clamp to the last day of a shorter month. */
  day?: number;
  /** Weekly only. `mon` … `sun`, or the full name. */
  weekday?: string;
  /** Hour, 0-23, on the job's clock. Not used by hourly jobs. */
  hour?: number;
  /** Minute, 0-59, on the job's clock. The job does not fire before it. */
  minute?: number;
  /**
   * IANA zone the schedule is read in — `Europe/Lisbon`, `Asia/Tokyo`. Absent means
   * this machine's local clock, which is also what every job written before the
   * field existed keeps doing.
   */
  timezone?: string;
  /**
   * How late a missed run may still fire: `"30m"`, `"6h"`, `"2d"`.
   *
   * Days and hours run to the end of that day or clock hour, so `"0d"` means "the
   * rest of the day it was due" and `"0h"` "the rest of that hour". Minutes are
   * exact. Absent means `"0d"`, or `"0h"` for an hourly job.
   *
   * This is deliberately a window rather than "whenever": a plugin loads whenever
   * you open the project, so an unbounded catch-up would fire runs nobody expected.
   */
  catchUp?: string;
  /** The pre-0.5 spelling of `catchUp: "<n>d"`. Still read. */
  catchUpDays?: number;
  prompt: string;
  agent?: string;
}

export interface Decision {
  due: boolean;
  reason: string;
  /** Dedupe key: one run per scheduled time. */
  key: string;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Wall-clock fields as one number, so wall times can be compared and stepped. */
function wall(year: number, monthIndex: number, day: number, hour = 0, minute = 0): number {
  return Date.UTC(year, monthIndex, day, hour, minute);
}

function fields(ordinal: number) {
  const d = new Date(ordinal);
  return {
    year: d.getUTCFullYear(),
    monthIndex: d.getUTCMonth(),
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    weekday: d.getUTCDay(),
  };
}

function nowWall(job: Job, now: Date): number {
  const c = wallClock(now, job.timezone);
  return wall(c.year, c.monthIndex, c.day, c.hour, c.minute);
}

const pad = (n: number) => String(n).padStart(2, "0");

export function everyOf(job: Pick<Job, "every">): Every {
  return job.every ?? "month";
}

/** `mon`, `Monday`, `MONDAY` → 1. -1 when it is not a weekday. */
export function weekdayIndex(value: unknown): number {
  if (typeof value !== "string") return -1;
  const v = value.trim().toLowerCase();
  return WEEKDAYS.findIndex((short, i) => v === short || v === WEEKDAY_NAMES[i].toLowerCase());
}

/** Length of a month, with the month index normalised so 12 means next January. */
export function daysInMonth(year: number, monthIndex: number): number {
  const first = new Date(year, monthIndex, 1);
  return new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
}

/**
 * The day a job actually fires on in a given month.
 *
 * 29, 30 and 31 mean "the last day" in a month that is too short — 31 in February is
 * the 28th, 30 in April is the 30th. Never construct the date first: `new Date(y, 1,
 * 31)` does not error, it rolls into March, which would fire on the wrong day rather
 * than the last one.
 */
export function effectiveDay(day: number, year: number, monthIndex: number): number {
  return Math.min(day, daysInMonth(year, monthIndex));
}

function monthFire(job: Job, year: number, monthIndex: number): number {
  const y = year + Math.floor(monthIndex / 12);
  const m = ((monthIndex % 12) + 12) % 12;
  return wall(y, m, effectiveDay(job.day ?? 1, y, m), job.hour ?? 0, job.minute ?? 0);
}

/** The most recent scheduled time at or before `now`, as wall time. */
function lastFire(job: Job, now: Date): number {
  const n = nowWall(job, now);
  const c = fields(n);
  const hour = job.hour ?? 0;
  const minute = job.minute ?? 0;
  switch (everyOf(job)) {
    case "hour": {
      const f = wall(c.year, c.monthIndex, c.day, c.hour, minute);
      return f > n ? f - HOUR : f;
    }
    case "day": {
      const f = wall(c.year, c.monthIndex, c.day, hour, minute);
      return f > n ? f - DAY : f;
    }
    case "week": {
      const back = (c.weekday - weekdayIndex(job.weekday) + 7) % 7;
      const f = wall(c.year, c.monthIndex, c.day - back, hour, minute);
      return f > n ? f - 7 * DAY : f;
    }
    default: {
      const f = monthFire(job, c.year, c.monthIndex);
      return f > n ? monthFire(job, c.year, c.monthIndex - 1) : f;
    }
  }
}

/** The scheduled time after `fire`, as wall time. */
function nextAfter(job: Job, fire: number): number {
  switch (everyOf(job)) {
    case "hour":
      return fire + HOUR;
    case "day":
      return fire + DAY;
    case "week":
      return fire + 7 * DAY;
    default: {
      const f = fields(fire);
      return monthFire(job, f.year, f.monthIndex + 1);
    }
  }
}

export interface CatchUp {
  amount: number;
  unit: "m" | "h" | "d";
}

/** The job's catch-up window, or null when `catchUp` cannot be read. */
export function catchUpOf(job: Pick<Job, "every" | "catchUp" | "catchUpDays">): CatchUp | null {
  if (job.catchUp !== undefined) {
    const match = /^\s*(\d+)\s*([mhd])\s*$/.exec(String(job.catchUp));
    return match ? { amount: Number(match[1]), unit: match[2] as CatchUp["unit"] } : null;
  }
  if (job.catchUpDays !== undefined) return { amount: job.catchUpDays, unit: "d" };
  return { amount: 0, unit: everyOf(job) === "hour" ? "h" : "d" };
}

/** "2d", "0h" — the window as it would be written in the file. */
export function catchUpText(job: Pick<Job, "every" | "catchUp" | "catchUpDays">): string {
  const c = catchUpOf(job);
  return c ? `${c.amount}${c.unit}` : String(job.catchUp);
}

/** The last wall minute a run scheduled at `fire` may still start in. */
function windowEnd(job: Job, fire: number): number {
  const { amount, unit } = catchUpOf(job) ?? { amount: 0, unit: "d" };
  const f = fields(fire);
  if (unit === "d") return wall(f.year, f.monthIndex, f.day + amount + 1) - MINUTE;
  if (unit === "h") return wall(f.year, f.monthIndex, f.day, f.hour + amount + 1) - MINUTE;
  return fire + amount * MINUTE;
}

/**
 * What a scheduled time is called in keys and claim file names.
 *
 * Monthly keys stay `YYYY-MM`, which is what claims written before 0.5 are named,
 * so upgrading does not re-run a month that already ran.
 */
function periodKey(job: Job, fire: number): string {
  const f = fields(fire);
  const month = `${f.year}-${pad(f.monthIndex + 1)}`;
  switch (everyOf(job)) {
    case "month":
      return month;
    case "hour":
      return `${month}-${pad(f.day)}T${pad(f.hour)}`;
    default:
      return `${month}-${pad(f.day)}`;
  }
}

/** The key of the run that matters right now: the latest scheduled time's. */
export function runKey(job: Job, now: Date): string {
  return `${job.id}/${periodKey(job, lastFire(job, now))}`;
}

function clampNote(job: Job, fire: number): string {
  if (everyOf(job) !== "month") return "";
  const f = fields(fire);
  return f.day !== job.day ? ` (day ${job.day} clamped to ${f.day})` : "";
}

/** "day 15", "Mon 24 Nov 09:00", "24 Nov 07:30" — a scheduled time in a log line. */
function label(job: Job, fire: number): string {
  const f = fields(fire);
  if (everyOf(job) === "month") return `day ${f.day}${clampNote(job, fire)}`;
  const date = new Date(fire).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
  const weekday = everyOf(job) === "week" ? `${WEEKDAY_NAMES[f.weekday].slice(0, 3)} ` : "";
  return `${weekday}${date} ${hhmm(f.hour, f.minute)}`;
}

function sameDay(a: number, b: number): boolean {
  return Math.floor(a / DAY) === Math.floor(b / DAY);
}

/**
 * Due means: the latest scheduled time has not run, and its window is still open.
 *
 * `lastRun` is the key persisted after a dispatch. Comparing keys rather than
 * timestamps is what makes a restart recover a missed run: reopen the day after
 * and it still fires, because the key is absent.
 *
 * The minute is part of the trigger: a job at 09:30 is not due at 09:00.
 */
export function evaluate(job: Job, now: Date, lastRun: string | undefined): Decision {
  const fire = lastFire(job, now);
  const key = `${job.id}/${periodKey(job, fire)}`;
  const n = nowWall(job, now);

  if (lastRun !== key && n <= windowEnd(job, fire)) {
    const onTime = everyOf(job) === "hour" ? Math.floor(n / HOUR) === Math.floor(fire / HOUR) : sameDay(n, fire);
    return { due: true, reason: onTime ? "due" : `late, catching up from ${label(job, fire)}`, key };
  }

  const next = nextAfter(job, fire);
  const f = fields(next);
  const waiting = sameDay(n, next) ? hhmm(f.hour, f.minute) : label(job, next);
  if (lastRun === key) return { due: false, reason: `already ran for ${periodKey(job, fire)}; next ${waiting}`, key };
  return { due: false, reason: `waiting for ${waiting}`, key };
}

/** The next instant this job is scheduled for, strictly after now. */
export function nextFireAt(job: Job, now: Date): Date {
  const f = fields(nextAfter(job, lastFire(job, now)));
  return zonedTime(f.year, f.monthIndex, f.day, f.hour, f.minute, job.timezone || undefined);
}

/** Human-readable next run, for the startup log and the status command. */
export function describeNext(job: Job, now: Date): string {
  if (evaluate(job, now, undefined).due) return "due now";
  const zone = job.timezone || undefined;
  const when = nextFireAt(job, now).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: zone });
  // Name the zone when it is not this machine's, so "1 Jan 08:00 Asia/Tokyo" cannot
  // be misread as 08:00 here.
  return zone ? `${when} ${zone}` : when;
}

/** "Mondays at 09:00", "hourly at :15", "day 31 (or last) at 08:00". No zone. */
export function describeSchedule(job: Job): string {
  const time = hhmm(job.hour ?? 0, job.minute);
  switch (everyOf(job)) {
    case "hour":
      return `hourly at :${pad(job.minute ?? 0)}`;
    case "day":
      return `daily at ${time}`;
    case "week": {
      const i = weekdayIndex(job.weekday);
      return `${i >= 0 ? WEEKDAY_NAMES[i] : String(job.weekday)}s at ${time}`;
    }
    default:
      return `day ${job.day}${(job.day ?? 0) > 28 ? " (or last)" : ""} at ${time}`;
  }
}

const isInt = (value: unknown, min: number, max: number) =>
  Number.isInteger(value) && (value as number) >= min && (value as number) <= max;

const ADJECTIVE: Record<Every, string> = { month: "monthly", week: "weekly", day: "daily", hour: "hourly" };

/** The longest catch-up, in minutes, that still ends before the next run is due. */
const LONGEST: Record<Every, { minutes: number; words: string }> = {
  hour: { minutes: 59, words: 'under an hour: "30m", or "0h" for the rest of that hour' },
  day: { minutes: 23 * 60 + 59, words: 'under a day: "6h", or "0d" for the rest of that day' },
  week: { minutes: 7 * 24 * 60 - 1, words: 'under a week: up to "6d"' },
  month: { minutes: 31 * 24 * 60, words: 'at most a month: up to "31d"' },
};

/**
 * What is wrong with a job's schedule, or null when it is fine.
 *
 * Each frequency takes only the fields it uses, and a field it does not use is
 * refused rather than ignored: a weekly job with `day: 15` would otherwise read as
 * "the 15th" to whoever opens the file, and run on a Monday.
 */
export function scheduleProblem(job: Record<string, unknown>): string | null {
  const every = (job.every ?? "month") as Every;
  if (!FREQUENCIES.includes(every)) return 'every must be "month", "week", "day" or "hour"';

  const has = (key: string) => job[key] !== undefined;
  if (every === "month") {
    if (!isInt(job.day, 1, 31)) {
      return "a monthly job needs day, a whole number from 1 to 31 (29-31 mean the last day of a shorter month)";
    }
    if (has("weekday")) return 'weekday is for weekly jobs; a monthly job uses day (or set every: "week")';
  }
  if (every === "week") {
    if (weekdayIndex(job.weekday) < 0) return "a weekly job needs weekday: mon, tue, wed, thu, fri, sat or sun";
    if (has("day")) return "day is for monthly jobs; a weekly job uses weekday";
  }
  if (every === "day" && (has("day") || has("weekday"))) return "a daily job runs every day: drop day and weekday";
  if (every === "hour") {
    if (has("day") || has("weekday") || has("hour")) {
      return "an hourly job runs every hour at its minute: drop day, weekday and hour";
    }
  } else if (!isInt(job.hour, 0, 23)) {
    return "hour must be a whole number from 0 to 23";
  }
  if (has("minute") && !isInt(job.minute, 0, 59)) return "minute must be a whole number from 0 to 59";

  if (has("catchUp") && has("catchUpDays")) return "give catchUp or catchUpDays, not both";
  if (has("catchUpDays") && !isInt(job.catchUpDays, 0, 31)) return "catchUpDays must be a whole number from 0 to 31";
  const catchUp = catchUpOf(job as Pick<Job, "every" | "catchUp" | "catchUpDays">);
  if (!catchUp) return 'catchUp is a length like "30m", "6h" or "2d"';
  if (catchUp.unit === "m" && catchUp.amount === 0) {
    // A one-minute window can fall between two ticks and never be seen.
    return 'catchUp "0m" could miss the run entirely; use "0h" or "0d" for the rest of that hour or day';
  }
  const minutes = catchUp.amount * { m: 1, h: 60, d: 1440 }[catchUp.unit];
  const limit = LONGEST[every];
  if (minutes > limit.minutes) {
    return `catchUp for ${every === "hour" ? "an" : "a"} ${ADJECTIVE[every]} job must be ${limit.words}`;
  }

  // A zone typo would otherwise produce a job that never fires, so it is refused
  // here rather than discovered by a run that does not happen.
  if (has("timezone") && (typeof job.timezone !== "string" || !isValidTimeZone(job.timezone))) {
    return "timezone must be an IANA name like Europe/Lisbon or Asia/Tokyo (omit it to use this machine's local time)";
  }
  return null;
}
