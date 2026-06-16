import { describe, expect, it } from "vitest";

import {
  computeCheckpointState,
  computePerCheckpointStates,
  creditCheckpoint,
} from "../../src/cycle/index.js";

// F-05 BR-26 Option A / TR-STAB-4 smoke tests for `computePerCheckpointStates`.
// Covers the P1D-03 ticket's four acceptance criteria plus boundary handling
// and a determinism guard. Full 8-state × edge-case matrix is P1D-05.

function utcDate(yyyyMmDd: string): Date {
  return new Date(`${yyyyMmDd}T00:00:00Z`);
}

// start = 2026-01-01 → anchors at 2026-04-01 (90), 2026-06-30 (180),
// 2026-09-28 (270), 2027-01-01 (365).
const start = utcDate("2026-01-01");

describe("computePerCheckpointStates — BR-26 Option A acceptance criteria", () => {
  it("AC #1: credited 90 + missed 180 + credited 270 → 180 stays catch_up (not auto-cleared by 270)", () => {
    // Today day 282. Visit on day 95 credits 90; visit on day 275 credits 270;
    // 180 was never logged. Option A: 180 stays surfaced as catch_up even
    // though a later checkpoint has been completed.
    const out = computePerCheckpointStates({
      aftercareStartDate: start,
      currentDate: utcDate("2026-10-10"),
      completedStabilityMeetings: [
        { serviceDate: utcDate("2026-04-05") }, // day 95 → credits 90
        { serviceDate: utcDate("2026-10-03") }, // day 275 → credits 270
      ],
    });
    expect(out).toStrictEqual([
      { anchor: 90, state: "complete" },
      { anchor: 180, state: "catch_up" },
      { anchor: 270, state: "complete" },
      { anchor: 365, state: "future" },
    ]);
  });

  it("AC #2: logging a visit credited per BR-25 to the missed 180 clears its catch_up", () => {
    // Same AC #1 setup plus a 180-day visit. BR-25 nearest-preceding maps
    // day 200 (2026-07-20) to the 180-day anchor; per BR-26, that single
    // visit is what's needed to flip 180 from catch_up to complete.
    const out = computePerCheckpointStates({
      aftercareStartDate: start,
      currentDate: utcDate("2026-10-10"),
      completedStabilityMeetings: [
        { serviceDate: utcDate("2026-04-05") }, // day 95  → credits 90
        { serviceDate: utcDate("2026-07-20") }, // day 200 → credits 180
        { serviceDate: utcDate("2026-10-03") }, // day 275 → credits 270
      ],
    });
    expect(out).toStrictEqual([
      { anchor: 90, state: "complete" },
      { anchor: 180, state: "complete" },
      { anchor: 270, state: "complete" },
      { anchor: 365, state: "future" },
    ]);
  });

  it("AC #3: multiple misses stack independently — fresh miss is overdue, older miss is catch_up", () => {
    // Today day 200 (2026-07-20). No visits logged: 90 and 180 are both
    // passed without credit; 180 is the most-recent passed anchor so it
    // surfaces as overdue (BR-29), while the older 90 sits behind it as
    // catch_up (BR-26 / BR-33). 270 and 365 are still future.
    const out = computePerCheckpointStates({
      aftercareStartDate: start,
      currentDate: utcDate("2026-07-20"),
      completedStabilityMeetings: [],
    });
    expect(out).toStrictEqual([
      { anchor: 90, state: "catch_up" },
      { anchor: 180, state: "overdue" },
      { anchor: 270, state: "future" },
      { anchor: 365, state: "future" },
    ]);
  });

  it("AC #4: composes with `computeCheckpointState` (P1D-01) and `creditCheckpoint` (P1D-02)", () => {
    // Same input as AC #1. The per-anchor breakdown agrees with the
    // aggregate state (`catch_up`) and lastCreditedCheckpoint (270), and
    // `creditCheckpoint` attributes each visit to the anchor the breakdown
    // marks as `complete`.
    const input = {
      aftercareStartDate: start,
      currentDate: utcDate("2026-10-10"),
      completedStabilityMeetings: [
        { serviceDate: utcDate("2026-04-05") }, // day 95  → 90
        { serviceDate: utcDate("2026-10-03") }, // day 275 → 270
      ],
    };
    const aggregate = computeCheckpointState(input);
    const perAnchor = computePerCheckpointStates(input);

    expect(aggregate.checkpointState).toBe("catch_up");
    expect(aggregate.lastCreditedCheckpoint).toBe(270);

    const oneEighty = perAnchor.find((p) => p.anchor === 180);
    expect(oneEighty?.state).toBe("catch_up");

    expect(creditCheckpoint(start, utcDate("2026-04-05"))).toBe(90);
    expect(creditCheckpoint(start, utcDate("2026-10-03"))).toBe(270);
  });
});

describe("computePerCheckpointStates — boundaries (BR-32 / FS-12 / VR-10)", () => {
  it("returns [] when aftercareStartDate is null (BR-32 / FS-12)", () => {
    expect(
      computePerCheckpointStates({
        aftercareStartDate: null,
        currentDate: utcDate("2026-05-22"),
        completedStabilityMeetings: [],
      }),
    ).toStrictEqual([]);
  });

  it("returns 4×future when aftercareStartDate is in the future (VR-10 pre-enrollment)", () => {
    expect(
      computePerCheckpointStates({
        aftercareStartDate: utcDate("2026-06-01"),
        currentDate: utcDate("2026-05-22"),
        completedStabilityMeetings: [],
      }),
    ).toStrictEqual([
      { anchor: 90, state: "future" },
      { anchor: 180, state: "future" },
      { anchor: 270, state: "future" },
      { anchor: 365, state: "future" },
    ]);
  });
});

describe("computePerCheckpointStates — purity", () => {
  it("produces identical output across repeated calls (no I/O, no Date.now())", () => {
    const input = {
      aftercareStartDate: start,
      currentDate: utcDate("2026-07-20"),
      completedStabilityMeetings: [],
    };
    const first = computePerCheckpointStates(input);
    for (let i = 0; i < 25; i++) {
      expect(computePerCheckpointStates(input)).toStrictEqual(first);
    }
  });
});
