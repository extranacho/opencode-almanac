// When a scheduled job is due. Pure, so it can be tested without the OpenCode server —
// this is the part that decides whether the batch runs at all, and the only part
// worth being paranoid about.

export interface Job {
  id: string;
  /** Day of the month, 1-31. 29-31 clamp to the last day of a shorter month. */
  day: number;
  /** Local hour, 0-23. */
  hour: number;
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
  const month = String(now.getMonth() + 1).padStart(2, "0");
  return `${job.id}/${now.getFullYear()}-${month}`;
}

/**
 * Due means: this month has not run, the window has opened, and it has not closed.
 *
 * `lastRun` is the key persisted after a dispatch. Comparing keys rather than
 * timestamps is what makes a restart recover a missed run: reopen the day after
 * and it still fires, because the key is absent.
 */
export function evaluate(job: Job, now: Date, lastRun: string | undefined): Decision {
  const key = monthKey(job, now);
  if (lastRun === key) return { due: false, reason: "already ran this month", key };

  const day = now.getDate();
  const target = effectiveDay(job.day, now.getFullYear(), now.getMonth());
  const clamped = target !== job.day ? ` (day ${job.day} clamped to ${target})` : "";

  if (day < target) return { due: false, reason: `waiting for day ${target}${clamped}`, key };
  if (day === target && now.getHours() < job.hour) {
    return { due: false, reason: `waiting for ${String(job.hour).padStart(2, "0")}:00`, key };
  }
  if (day > target + job.catchUpDays) {
    return { due: false, reason: `window closed after day ${target + job.catchUpDays}${clamped}`, key };
  }
  return { due: true, reason: day === target ? "due" : `late, catching up from day ${target}${clamped}`, key };
}

/** Human-readable next run, for the startup log and the status command. */
export function describeNext(job: Job, now: Date): string {
  if (evaluate(job, now, undefined).due) return "due now";
  const at = (year: number, monthIndex: number) => {
    const first = new Date(year, monthIndex, 1);
    const y = first.getFullYear();
    const m = first.getMonth();
    return new Date(y, m, effectiveDay(job.day, y, m), job.hour, job.minute ?? 0, 0, 0);
  };

  let next = at(now.getFullYear(), now.getMonth());
  if (next.getTime() <= now.getTime()) next = at(now.getFullYear(), now.getMonth() + 1);
  return next.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
}
