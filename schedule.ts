// When a scheduled job is due. Pure, so it can be tested without the OpenCode server —
// this is the part that decides whether the batch runs at all, and the only part
// worth being paranoid about.

export interface Job {
  id: string;
  /** Day of the month, 1-28. */
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
  if (day < job.day) return { due: false, reason: `waiting for day ${job.day}`, key };
  if (day === job.day && now.getHours() < job.hour) {
    return { due: false, reason: `waiting for ${String(job.hour).padStart(2, "0")}:00`, key };
  }
  if (day > job.day + job.catchUpDays) {
    return { due: false, reason: `window closed after day ${job.day + job.catchUpDays}`, key };
  }
  return { due: true, reason: day === job.day ? "due" : `late, catching up from day ${job.day}`, key };
}

/** Human-readable next run, for the startup log and the status command. */
export function describeNext(job: Job, now: Date): string {
  if (evaluate(job, now, undefined).due) return "due now";
  const thisMonth = new Date(now.getFullYear(), now.getMonth(), job.day, job.hour, 0, 0, 0);
  const next =
    thisMonth.getTime() > now.getTime()
      ? thisMonth
      : new Date(now.getFullYear(), now.getMonth() + 1, job.day, job.hour, 0, 0, 0);
  return next.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
}
