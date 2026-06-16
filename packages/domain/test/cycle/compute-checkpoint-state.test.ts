import { describe, expect, it } from "vitest";

import { computeCheckpointState } from "../../src/cycle/index.js";

// F-05 P1D-01 smoke tests: happy path + nulls + each enum value the function
// can emit. Full state × edge-case matrix is P1D-05.

function utcDate(yyyyMmDd: string): Date {
  return new Date(`${yyyyMmDd}T00:00:00Z`);
}

describe("computeCheckpointState — boundary states (FS-12 / VR-10 / AC-21)", () => {
  it("returns not_in_cycle when aftercareStartDate is null (BR-32 / FS-12)", () => {
    const out = computeCheckpointState({
      aftercareStartDate: null,
      currentDate: utcDate("2026-05-22"),
      completedStabilityMeetings: [],
    });
    expect(out).toStrictEqual({
      checkpointState: "not_in_cycle",
      daysToNext: null,
      daysOverdue: 0,
      nextCheckpoint: null,
      lastCreditedCheckpoint: null,
    });
  });

  it("returns pre_enrollment when start date is in the future (VR-10)", () => {
    const out = computeCheckpointState({
      aftercareStartDate: utcDate("2026-06-01"),
      currentDate: utcDate("2026-05-22"),
      completedStabilityMeetings: [],
    });
    expect(out.checkpointState).toBe("pre_enrollment");
    expect(out.nextCheckpoint).toBe(90);
    expect(out.daysToNext).toBe(10 + 90); // 10 days until start + 90d to first anchor
    expect(out.daysOverdue).toBe(0);
    expect(out.lastCreditedCheckpoint).toBeNull();
  });

  it("returns cycle_complete when currentDate is past day 365 + due window (AC-21)", () => {
    const start = utcDate("2025-01-01");
    const beyond = utcDate("2026-01-20"); // 365 + 19 days
    const out = computeCheckpointState({
      aftercareStartDate: start,
      currentDate: beyond,
      completedStabilityMeetings: [],
    });
    expect(out.checkpointState).toBe("cycle_complete");
    expect(out.nextCheckpoint).toBeNull();
    expect(out.daysToNext).toBeNull();
  });
});

describe("computeCheckpointState — in-cycle states (BR-28 / BR-29 / BR-31 / BR-33)", () => {
  // start = 2026-01-01 → anchors at 2026-04-01 (90), 2026-06-30 (180),
  // 2026-09-28 (270), 2026-12-27 (365).
  const start = utcDate("2026-01-01");

  it("returns between when most recent passed is credited and next is beyond due window", () => {
    // Day 100: 90-day anchor (2026-04-01) passed and credited; next at
    // 2026-06-30 is ~81 days out → between (not yet within 14-day due window).
    const out = computeCheckpointState({
      aftercareStartDate: start,
      currentDate: utcDate("2026-04-11"),
      completedStabilityMeetings: [{ serviceDate: utcDate("2026-04-05") }],
    });
    expect(out.checkpointState).toBe("between");
    expect(out.nextCheckpoint).toBe(180);
    expect(out.lastCreditedCheckpoint).toBe(90);
    expect(out.daysOverdue).toBe(0);
    expect(out.daysToNext).toBeGreaterThan(14);
  });

  it("returns due when next checkpoint is within DUE_WINDOW_DAYS (BR-28)", () => {
    // Day 83: 90-day anchor (2026-04-01) is 7 days out → due.
    const out = computeCheckpointState({
      aftercareStartDate: start,
      currentDate: utcDate("2026-03-25"),
      completedStabilityMeetings: [],
    });
    expect(out.checkpointState).toBe("due");
    expect(out.nextCheckpoint).toBe(90);
    expect(out.daysToNext).toBe(7);
    expect(out.daysOverdue).toBe(0);
    expect(out.lastCreditedCheckpoint).toBeNull();
  });

  it("returns overdue when most recent passed is uncredited and no older miss (BR-29)", () => {
    // Day 95: 90-day anchor (2026-04-01) passed 5 days ago, no visit logged.
    const out = computeCheckpointState({
      aftercareStartDate: start,
      currentDate: utcDate("2026-04-06"),
      completedStabilityMeetings: [],
    });
    expect(out.checkpointState).toBe("overdue");
    expect(out.daysOverdue).toBe(5);
    expect(out.nextCheckpoint).toBe(180);
    expect(out.lastCreditedCheckpoint).toBeNull();
  });

  it("returns catch_up when an older checkpoint is missed and later activity exists (BR-33)", () => {
    // Day 200: 90-day passed without credit; 180-day passed WITH credit.
    // The miss at 90 sits behind a later credit → catch_up.
    const out = computeCheckpointState({
      aftercareStartDate: start,
      currentDate: utcDate("2026-07-20"),
      completedStabilityMeetings: [{ serviceDate: utcDate("2026-07-05") }],
    });
    expect(out.checkpointState).toBe("catch_up");
    expect(out.lastCreditedCheckpoint).toBe(180);
    expect(out.nextCheckpoint).toBe(270);
    // Most recent uncredited passed anchor is the 90-day mark.
    expect(out.daysOverdue).toBeGreaterThan(90);
  });

  it("multiple visits in the 90-day window credit the 90 anchor exactly once (AC #5 / P1D-02)", () => {
    // Day 100: two visits at days 95 and 100, both in the 90-day window.
    // BR-25 maps both to the 90-day anchor; the credited flag is idempotent
    // so lastCreditedCheckpoint stays at 90, not 180. FS-13 visit-attribution
    // metadata is intentionally not surfaced — only the anchor is reported.
    const out = computeCheckpointState({
      aftercareStartDate: start,
      currentDate: utcDate("2026-04-11"),
      completedStabilityMeetings: [
        { serviceDate: utcDate("2026-04-05") }, // day 94
        { serviceDate: utcDate("2026-04-10") }, // day 99
      ],
    });
    expect(out.lastCreditedCheckpoint).toBe(90);
    expect(out.nextCheckpoint).toBe(180);
    expect(out.daysOverdue).toBe(0);
  });

  it("returns complete when all four anchors are credited and we're inside the 14-day grace", () => {
    // Day 370: past the 365 anchor but inside 365 + DUE_WINDOW_DAYS; all four
    // visits credited → complete (cycle_complete fires only after grace).
    const out = computeCheckpointState({
      aftercareStartDate: start,
      currentDate: utcDate("2027-01-06"), // start + 370d
      completedStabilityMeetings: [
        { serviceDate: utcDate("2026-04-02") },
        { serviceDate: utcDate("2026-07-02") },
        { serviceDate: utcDate("2026-09-30") },
        { serviceDate: utcDate("2027-01-02") }, // must be ≥ 365-day anchor (2027-01-01) to credit it
      ],
    });
    expect(out.checkpointState).toBe("complete");
    expect(out.lastCreditedCheckpoint).toBe(365);
    expect(out.nextCheckpoint).toBeNull();
    expect(out.daysToNext).toBeNull();
    expect(out.daysOverdue).toBe(0);
  });
});

describe("computeCheckpointState — purity / determinism", () => {
  it("produces identical output across repeated calls (no I/O, no Date.now())", () => {
    const input = {
      aftercareStartDate: utcDate("2026-01-01"),
      currentDate: utcDate("2026-04-06"),
      completedStabilityMeetings: [],
    };
    const first = computeCheckpointState(input);
    for (let i = 0; i < 50; i++) {
      expect(computeCheckpointState(input)).toStrictEqual(first);
    }
  });

  it("honors a custom dueWindowDays override (BR-28 N is config)", () => {
    const start = utcDate("2026-01-01");
    // With default 14-day window, 7 days out = due. With a 5-day window,
    // 7 days out should be `between` instead.
    const tight = computeCheckpointState({
      aftercareStartDate: start,
      currentDate: utcDate("2026-03-25"),
      completedStabilityMeetings: [],
      dueWindowDays: 5,
    });
    expect(tight.checkpointState).toBe("between");
  });
});
