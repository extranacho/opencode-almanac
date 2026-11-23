// When a scheduled job is due. Pure, so it can be tested without the OpenCode server —
// this is the part that decides whether the batch runs at all, and the only part
// worth being paranoid about.

import { hhmm, wallClock, zonedTime } from "./tz.ts";

export interface Job {
  id: string;
  /** Day of the month, 1-31. 29-31 clamp to the last day of a shorter month. */
  day: number;
  /** Hour, 0-23, on the job's clock. */
  hour: number;
  /** Minute, 0-59, on the job's clock. The job does not fire before it. */
  minute?: number;
  /**
   * IANA zone the day, hour and minute are read in — `Europe/Lisbon`,
   * `Asia/Tokyo`. Absent means this machine's local clock, which is also what
   * every job written before the field existed keeps doing.
   */
  timezone?: string;
  /**
   * How many days past `day` a missed run may still fire.
   *
   * 0 means strictly on the day. This is deliberately a window rather than "any
   * time this month": a plugin loads whenever you open the project, so an
   * unbounded catch-up would fire the first time you opened it in a month whose
   * job had never run — including a month where nothing was ever expected.
   */
  catchUpDays: number;
  prompt: string;
  agent?: string;
}

export interface Decision {
  due: boolean;
  reason: string;
  /** Dedupe key: one run per job per month, whatever day it lands on. */
  key: string;
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

export function monthKey(job: Job, now: Date): string {
  const clock = wallClock(now, job.timezone);
  const month = String(clock.monthIndex + 1).padStart(2, "0");
  return `${job.id}/${clock.year}-${month}`;
}

/**
 * Due means: this month has not run, the window has opened, and it has not closed.
 *
 * `lastRun` is the key persisted after a dispatch. Comparing keys rather than
 * timestamps is what makes a restart recover a missed run: reopen the day after
 * and it still fires, because the key is absent.
 *
 * The hour *and* the minute gate the day: a job at 09:30 is not due at 09:00. The
 * comparison is in minutes since midnight so the two cannot drift apart.
 */
export function evaluate(job: Job, now: Date, lastRun: string | undefined): Decision {
  const key = monthKey(job, now);
  if (lastRun === key) return { due: false, reason: "already ran this month", key };

  const clock = wallClock(now, job.timezone);
  const day = clock.day;
  const target = effectiveDay(job.day, clock.year, clock.monthIndex);
  const clamped = target !== job.day ? ` (day ${job.day} clamped to ${target})` : "";

  if (day < target) return { due: false, reason: `waiting for day ${target}${clamped}`, key };
  if (day === target && clock.hour * 60 + clock.minute < job.hour * 60 + (job.minute ?? 0)) {
    return { due: false, reason: `waiting for ${hhmm(job.hour, job.minute)}`, key };
  }
  if (day > target + job.catchUpDays) {
    return { due: false, reason: `window closed after day ${target + job.catchUpDays}${clamped}`, key };
  }
  return { due: true, reason: day === target ? "due" : `late, catching up from day ${target}${clamped}`, key };
}

/** Human-readable next run, for the startup log and the status command. */
export function describeNext(job: Job, now: Date): string {
  if (evaluate(job, now, undefined).due) return "due now";
  const zone = job.timezone || undefined;
  const clock = wallClock(now, zone);
  const at = (year: number, monthIndex: number) =>
    zonedTime(year, monthIndex, effectiveDay(job.day, year, monthIndex), job.hour, job.minute ?? 0, zone);

  let next = at(clock.year, clock.monthIndex);
  if (next.getTime() <= now.getTime()) next = at(clock.year, clock.monthIndex + 1);
  const when = next.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: zone });
  // Name the zone when it is not this machine's, so "1 Jan 08:00 Asia/Tokyo" cannot
  // be misread as 08:00 here.
  return zone ? `${when} ${zone}` : when;
}
