import { describe, expect, it } from "vitest";
import { describeNext, evaluate, monthKey, type Job } from "../schedule.ts";

const job: Job = {
  id: "batch",
  day: 1,
  hour: 8,
  catchUpDays: 7,
  prompt: "run it",
};

/** Local-time date, because the scheduler runs on the machine clock. */
function at(year: number, month: number, day: number, hour = 12): Date {
  return new Date(year, month - 1, day, hour, 0, 0, 0);
}

describe("almanac due-ness", () => {
  it("fires on the day, at or after the hour", () => {
    expect(evaluate(job, at(2027, 1, 1, 7), undefined).due).toBe(false);
    expect(evaluate(job, at(2027, 1, 1, 8), undefined).due).toBe(true);
    expect(evaluate(job, at(2027, 1, 1, 23), undefined).due).toBe(true);
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
