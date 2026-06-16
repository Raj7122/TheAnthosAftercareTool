import { describe, expect, it } from "vitest";

import { evaluateQueuePredicate } from "../../src/priority/index.js";
import type { QueueMembershipInput } from "../../src/priority/index.js";
import type { QueuePredicate } from "../../src/config/index.js";

// F-04 BR-22 / P1C-01 — `evaluateQueuePredicate` decides queue membership for
// each of the four M-CONFIG predicate kinds. BR-21 (sort within queue) is a
// separate concern; this suite pins membership only.

// A fixed scoring clock — May 2026 — so the `currentCalendarMonthOnly` arm is
// deterministic.
const NOW = new Date("2026-05-15T12:00:00Z");

// A baseline membership input; each test overrides only the fields it exercises.
function input(overrides: Partial<QueueMembershipInput> = {}): QueueMembershipInput {
  return {
    daysSinceLastSuccessfulContact: 10,
    hasEverBeenSuccessfullyContacted: true,
    failedAttempts: 0,
    daysUntilNextCheckIn: 10,
    nextCheckInDate: new Date("2026-05-20T00:00:00Z"),
    ...overrides,
  };
}

describe("evaluateQueuePredicate — all_active (BR-22 caseload overview)", () => {
  const predicate: QueuePredicate = { kind: "all_active" };

  it("admits every participant (VR-08)", () => {
    expect(evaluateQueuePredicate(predicate, input(), NOW)).toBe(true);
    expect(
      evaluateQueuePredicate(
        predicate,
        input({ daysSinceLastSuccessfulContact: null }),
        NOW,
      ),
    ).toBe(true);
  });
});

describe("evaluateQueuePredicate — due_within_days (BR-22 due soon)", () => {
  const predicate: QueuePredicate = {
    kind: "due_within_days",
    params: { days: 30 },
  };

  it("admits a participant due exactly on the boundary (30 days)", () => {
    expect(
      evaluateQueuePredicate(predicate, input({ daysUntilNextCheckIn: 30 }), NOW),
    ).toBe(true);
  });

  it("excludes a participant 31 days out (EC-13)", () => {
    expect(
      evaluateQueuePredicate(predicate, input({ daysUntilNextCheckIn: 31 }), NOW),
    ).toBe(false);
  });

  it("admits a participant due today (0 days)", () => {
    expect(
      evaluateQueuePredicate(predicate, input({ daysUntilNextCheckIn: 0 }), NOW),
    ).toBe(true);
  });

  it("excludes a past-due participant (negative delta)", () => {
    expect(
      evaluateQueuePredicate(predicate, input({ daysUntilNextCheckIn: -3 }), NOW),
    ).toBe(false);
  });

  it("excludes a participant with no forward-looking due date", () => {
    expect(
      evaluateQueuePredicate(
        predicate,
        input({ daysUntilNextCheckIn: null }),
        NOW,
      ),
    ).toBe(false);
  });
});

describe("evaluateQueuePredicate — never_successfully_contacted (BR-22)", () => {
  const predicate: QueuePredicate = {
    kind: "never_successfully_contacted",
    params: { minFailedAttempts: 2 },
  };

  it("admits: never contacted AND failed attempts at the threshold", () => {
    expect(
      evaluateQueuePredicate(
        predicate,
        input({ hasEverBeenSuccessfullyContacted: false, failedAttempts: 2 }),
        NOW,
      ),
    ).toBe(true);
  });

  it("excludes a participant who has been successfully contacted", () => {
    expect(
      evaluateQueuePredicate(
        predicate,
        input({ hasEverBeenSuccessfullyContacted: true, failedAttempts: 5 }),
        NOW,
      ),
    ).toBe(false);
  });

  it("excludes a never-contacted participant below the failed-attempt threshold", () => {
    expect(
      evaluateQueuePredicate(
        predicate,
        input({ hasEverBeenSuccessfullyContacted: false, failedAttempts: 1 }),
        NOW,
      ),
    ).toBe(false);
  });
});

describe("evaluateQueuePredicate — successful_contact_overdue (BR-22 check-ins due)", () => {
  it("admits: contact overdue AND next check-in this calendar month", () => {
    const predicate: QueuePredicate = {
      kind: "successful_contact_overdue",
      params: { minDaysSinceContact: 28, currentCalendarMonthOnly: true },
    };
    expect(
      evaluateQueuePredicate(
        predicate,
        input({
          daysSinceLastSuccessfulContact: 28,
          nextCheckInDate: new Date("2026-05-31T00:00:00Z"),
        }),
        NOW,
      ),
    ).toBe(true);
  });

  it("excludes: contact overdue but next check-in falls next month", () => {
    const predicate: QueuePredicate = {
      kind: "successful_contact_overdue",
      params: { minDaysSinceContact: 28, currentCalendarMonthOnly: true },
    };
    expect(
      evaluateQueuePredicate(
        predicate,
        input({
          daysSinceLastSuccessfulContact: 40,
          nextCheckInDate: new Date("2026-06-01T00:00:00Z"),
        }),
        NOW,
      ),
    ).toBe(false);
  });

  it("excludes: days-since-contact below the threshold", () => {
    const predicate: QueuePredicate = {
      kind: "successful_contact_overdue",
      params: { minDaysSinceContact: 28, currentCalendarMonthOnly: true },
    };
    expect(
      evaluateQueuePredicate(
        predicate,
        input({
          daysSinceLastSuccessfulContact: 27,
          nextCheckInDate: new Date("2026-05-31T00:00:00Z"),
        }),
        NOW,
      ),
    ).toBe(false);
  });

  it("excludes a never-contacted participant (null days-since-contact)", () => {
    const predicate: QueuePredicate = {
      kind: "successful_contact_overdue",
      params: { minDaysSinceContact: 28, currentCalendarMonthOnly: true },
    };
    expect(
      evaluateQueuePredicate(
        predicate,
        input({ daysSinceLastSuccessfulContact: null }),
        NOW,
      ),
    ).toBe(false);
  });

  it("ignores the calendar-month gate when currentCalendarMonthOnly is false", () => {
    const predicate: QueuePredicate = {
      kind: "successful_contact_overdue",
      params: { minDaysSinceContact: 28, currentCalendarMonthOnly: false },
    };
    expect(
      evaluateQueuePredicate(
        predicate,
        input({
          daysSinceLastSuccessfulContact: 40,
          nextCheckInDate: new Date("2026-09-01T00:00:00Z"),
        }),
        NOW,
      ),
    ).toBe(true);
  });

  it("excludes when currentCalendarMonthOnly is set but no next check-in date exists", () => {
    const predicate: QueuePredicate = {
      kind: "successful_contact_overdue",
      params: { minDaysSinceContact: 28, currentCalendarMonthOnly: true },
    };
    expect(
      evaluateQueuePredicate(
        predicate,
        input({
          daysSinceLastSuccessfulContact: 40,
          nextCheckInDate: null,
        }),
        NOW,
      ),
    ).toBe(false);
  });
});
