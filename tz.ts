// The wall clock a job is scheduled against.
//
// Every question the scheduler asks — is it the day, has the hour come, which
// month does the claim belong to — is a question about a clock on a wall, not
// about an instant. A job with no `timezone` reads this machine's clock, which is
// what almanac always did. A job with one reads the same clock in that zone, so
// the answer no longer depends on where the laptop happens to be.
//
// Node carries full ICU, so `Intl` is the offset database; nothing here hard-codes
// a UTC offset, and daylight saving is whatever the zone says it is.

export interface WallClock {
  year: number;
  /** 0-11, like `Date.getMonth()`. */
  monthIndex: number;
  day: number;
  hour: number;
  minute: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let cached = formatters.get(timeZone);
  if (!cached) {
    cached = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, cached);
  }
  return cached;
}

/** Whether `Intl` recognises the name. A typo would otherwise schedule a job at NaN. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

function parts(now: Date, timeZone: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(now)) {
    if (part.type !== "literal") out[part.type] = Number(part.value);
  }
  return out;
}

/** What a clock in `timeZone` reads at this instant. Undefined zone means local. */
export function wallClock(now: Date, timeZone?: string): WallClock {
  if (!timeZone) {
    return {
      year: now.getFullYear(),
      monthIndex: now.getMonth(),
      day: now.getDate(),
      hour: now.getHours(),
      minute: now.getMinutes(),
    };
  }
  // Some ICU builds print midnight as hour 24 under a 12-hour cycle; `% 24` keeps
  // it honest whichever cycle the formatter ends up using.
  const p = parts(now, timeZone);
  return { year: p.year, monthIndex: p.month - 1, day: p.day, hour: p.hour % 24, minute: p.minute };
}

/** How far ahead of UTC the zone is, in milliseconds, at that instant. */
function offsetMs(at: Date, timeZone: string): number {
  const p = parts(at, timeZone);
  const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second);
  return asUTC - Math.floor(at.getTime() / 1000) * 1000;
}

/**
 * The instant at which a clock in `timeZone` reads that date and time.
 *
 * Two passes, because the offset depends on the instant being computed: read the
 * offset at the naive UTC guess, correct by it, then read again in case the first
 * correction crossed a daylight-saving boundary.
 *
 * Two wall times have no exact answer, and neither is a scheduling problem:
 *
 * - The hour a spring-forward skips. There is no 01:30 to return, so this gives the
 *   same reading an hour later rather than inventing one. The due check does not
 *   depend on it — it fires on the first tick the clock reads at or past the
 *   requested time, which in the gap is the jump itself.
 * - The hour an autumn change repeats. This returns the later of the two, so a job
 *   at 01:00 fires once, at the second 01:00.
 */
export function zonedTime(
  year: number,
  monthIndex: number,
  day: number,
  hour: number,
  minute: number,
  timeZone?: string,
): Date {
  if (!timeZone) return new Date(year, monthIndex, day, hour, minute, 0, 0);
  const guess = Date.UTC(year, monthIndex, day, hour, minute, 0, 0);
  const first = guess - offsetMs(new Date(guess), timeZone);
  return new Date(guess - offsetMs(new Date(first), timeZone));
}

/** "08:00", the shape every log line and panel row uses. */
export function hhmm(hour: number, minute?: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute ?? 0).padStart(2, "0")}`;
}
