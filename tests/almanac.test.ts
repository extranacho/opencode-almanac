import { describe, expect, it } from "vitest";
import { daysInMonth, describeNext, effectiveDay, evaluate, monthKey, type Job } from "../schedule.ts";
import { zonedTime } from "../tz.ts";

const job: Job = {
  id: "batch",
  day: 1,
  hour: 8,
  catchUpDays: 7,
  prompt: "run it",
};

/** Local-time date, because a job without a timezone runs on the machine clock. */
function at(year: number, month: number, day: number, hour = 12, minute = 0): Date {
  return new Date(year, month - 1, day, hour, minute, 0, 0);
}

/** A fixed instant, for the tests that must not depend on the machine's zone. */
function utc(year: number, month: number, day: number, hour = 12, minute = 0): Date {
  return new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0));
}

describe("almanac due-ness", () => {
  it("fires on the day, at or after the hour", () => {
    expect(evaluate(job, at(2027, 1, 1, 7), undefined).due).toBe(false);
    expect(evaluate(job, at(2027, 1, 1, 8), undefined).due).toBe(true);
    expect(evaluate(job, at(2027, 1, 1, 23), undefined).due).toBe(true);
  });

  it("waits for the minute, not just the hour", () => {
    const halfPast: Job = { ...job, hour: 9, minute: 30 };
    expect(evaluate(halfPast, at(2027, 1, 1, 9, 0), undefined).due).toBe(false);
    expect(evaluate(halfPast, at(2027, 1, 1, 9, 29), undefined).due).toBe(false);
    expect(evaluate(halfPast, at(2027, 1, 1, 9, 30), undefined).due).toBe(true);
    expect(evaluate(halfPast, at(2027, 1, 1, 9, 31), undefined).due).toBe(true);
    expect(evaluate(halfPast, at(2027, 1, 1, 9, 0), undefined).reason).toBe("waiting for 09:30");
  });

  it("does not fire before the day arrives", () => {
    const midMonth: Job = { ...job, day: 15 };
    const decision = evaluate(midMonth, at(2026, 12, 10), undefined);
    expect(decision.due).toBe(false);
    expect(decision.reason).toBe("waiting for day 15");
    // A day-1 job read on the last day of the month is waiting for the next month,
    // which is what a closed window looks like from here.
    expect(evaluate(job, at(2026, 12, 31), undefined).reason).toBe("window closed after day 8");
  });

  it("does not fire twice in the same month", () => {
    const when = at(2027, 1, 3);
    const decision = evaluate(job, when, monthKey(job, when));
    expect(decision.due).toBe(false);
    expect(decision.reason).toBe("already ran this month");
  });

  it("catches up inside the window, and gives up outside it", () => {
    // Day 8 is the last day of a 7-day window.
    expect(evaluate(job, at(2027, 1, 7), undefined).due).toBe(true);
    expect(evaluate(job, at(2027, 1, 8), undefined).due).toBe(true);
    expect(evaluate(job, at(2027, 1, 9), undefined).due).toBe(false);
  });

  it("never backfills a month it slept through", () => {
    // Open in February with January unrun: February's own key is what matters.
    const february = at(2027, 2, 1, 9);
    expect(evaluate(job, february, undefined).due).toBe(true);
    // A driver that had stamped January must not suppress February's run.
    expect(evaluate(job, february, "batch/2027-01").due).toBe(true);
  });

  it("treats catchUpDays 0 as strictly that day", () => {
    const strict: Job = { ...job, catchUpDays: 0 };
    expect(evaluate(strict, at(2027, 1, 1, 9), undefined).due).toBe(true);
    expect(evaluate(strict, at(2027, 1, 2, 9), undefined).due).toBe(false);
  });

  it("reports the next run in both directions", () => {
    expect(describeNext(job, at(2026, 12, 20))).toContain("Jan");
    // Inside the catch-up window it is due, not scheduled — say so.
    expect(describeNext(job, at(2027, 1, 2))).toBe("due now");
    // Past the window, the next run is next month.
    expect(describeNext(job, at(2027, 1, 20))).toContain("Feb");
    expect(describeNext(job, at(2027, 1, 1, 9))).toBe("due now");
  });
});

describe("a job's timezone", () => {
  // 08:00 in Tokyo is 23:00 UTC the day before. Nothing here may depend on where
  // the test machine thinks it is.
  const tokyo: Job = { ...job, hour: 8, minute: 0, timezone: "Asia/Tokyo" };

  it("reads the day and hour on its own clock", () => {
    // 22:00 UTC on 31 Dec is 07:00 on 1 Jan in Tokyo: the day has come, the hour has not.
    expect(evaluate(tokyo, utc(2026, 12, 31, 22), undefined).reason).toBe("waiting for 08:00");
    // 23:00 UTC on 31 Dec is 08:00 on 1 Jan in Tokyo.
    expect(evaluate(tokyo, utc(2026, 12, 31, 23), undefined).due).toBe(true);
    // 07:00 UTC on 1 Jan is 16:00 in Tokyo, still inside the day and the window.
    expect(evaluate(tokyo, utc(2027, 1, 1, 7), undefined).due).toBe(true);
  });

  it("keys the month on that clock too", () => {
    // A Tokyo job on 1 Jan claims January while the machine is still in December.
    expect(monthKey(tokyo, utc(2026, 12, 31, 23))).toBe("batch/2027-01");
    expect(monthKey(tokyo, utc(2026, 12, 31, 14))).toBe("batch/2026-12");
  });

  it("keeps the day boundary in the zone", () => {
    const job15: Job = { ...job, day: 15, timezone: "Asia/Tokyo" };
    // 14 Jan 15:30 UTC is 00:30 on the 15th in Tokyo — on its day, before its hour.
    expect(evaluate(job15, utc(2027, 1, 14, 15, 30), undefined).reason).toBe("waiting for 08:00");
    // 14 Jan 23:30 UTC is 15 Jan 08:30 in Tokyo: due, on the 15th.
    expect(evaluate(job15, utc(2027, 1, 14, 23, 30), undefined).due).toBe(true);
  });

  it("names the zone when it reports the next run", () => {
    expect(describeNext(tokyo, utc(2026, 12, 20, 0))).toContain("Asia/Tokyo");
    // A job with no zone keeps the old, zone-free wording.
    expect(describeNext(job, at(2026, 12, 20))).not.toContain("Asia/Tokyo");
  });

  it("follows daylight saving rather than a fixed offset", () => {
    // Lisbon is UTC+0 in January and UTC+1 from the last Sunday in March, so 08:00
    // there is 08:00 UTC and then 07:00 UTC. A hard-coded offset gets one of these
    // an hour wrong.
    expect(zonedTime(2027, 0, 15, 8, 0, "Europe/Lisbon").toISOString()).toBe("2027-01-15T08:00:00.000Z");
    expect(zonedTime(2027, 6, 15, 8, 0, "Europe/Lisbon").toISOString()).toBe("2027-07-15T07:00:00.000Z");
    // And with no zone it is the Date constructor's own local reading, unchanged.
    expect(zonedTime(2027, 0, 15, 8, 0).getTime()).toBe(at(2027, 1, 15, 8).getTime());
  });

  it("resolves the two awkward hours predictably", () => {
    // Lisbon skips 01:00-01:59 on 28 March 2027. There is no 01:30 to return, so it
    // lands on that reading an hour later rather than inventing one.
    expect(zonedTime(2027, 2, 28, 1, 30, "Europe/Lisbon").toISOString()).toBe("2027-03-28T01:30:00.000Z");
    // 31 October 2027 repeats 01:00-01:59. The later of the two is used, so a job
    // at 01:00 fires once, not twice.
    expect(zonedTime(2027, 9, 31, 1, 0, "Europe/Lisbon").toISOString()).toBe("2027-10-31T01:00:00.000Z");
  });
});

describe("days 29-31 clamp to the last day", () => {
  const monthEnd = (day: number, catchUpDays = 0): Job => ({ ...job, day, catchUpDays });

  it("knows how long a month is", () => {
    expect(daysInMonth(2027, 1)).toBe(28); // February, not a leap year
    expect(daysInMonth(2028, 1)).toBe(29); // leap
    expect(daysInMonth(2027, 3)).toBe(30); // April
    expect(daysInMonth(2027, 11)).toBe(31);
    expect(daysInMonth(2026, 12)).toBe(31); // index 12 normalises to Jan 2027
  });

  it("clamps only when the month is too short", () => {
    expect(effectiveDay(31, 2027, 1)).toBe(28);
    expect(effectiveDay(30, 2027, 1)).toBe(28);
    expect(effectiveDay(29, 2027, 1)).toBe(28);
    expect(effectiveDay(29, 2028, 1)).toBe(29); // leap February keeps it
    expect(effectiveDay(31, 2027, 3)).toBe(30); // April
    expect(effectiveDay(31, 2027, 0)).toBe(31);
    expect(effectiveDay(15, 2027, 1)).toBe(15);
  });

  it("fires on the clamped day, not on a rolled-over date", () => {
    // 31 February is the 28th here, not 3 March.
    expect(evaluate(monthEnd(31), at(2027, 2, 27, 23), undefined).due).toBe(false);
    expect(evaluate(monthEnd(31), at(2027, 2, 28, 8), undefined).due).toBe(true);
    // And it is not still "due" a day later once the window closes.
    expect(evaluate(monthEnd(31), at(2027, 2, 28, 8), "batch/2027-02").due).toBe(false);
  });

  it("reports the clamp in the reason", () => {
    expect(evaluate(monthEnd(31), at(2027, 2, 10), undefined).reason).toBe(
      "waiting for day 28 (day 31 clamped to 28)",
    );
  });
});
