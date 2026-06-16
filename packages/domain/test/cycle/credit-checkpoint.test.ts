import { describe, expect, it } from "vitest";

import { creditCheckpoint } from "../../src/cycle/index.js";

// F-05 BR-25 / TR-STAB-3 smoke tests for `creditCheckpoint`: the canonical
// FS F-05 example (day 200 → 180) is the first assertion per the P1D-02
// ticket Notes. Full state × edge-case matrix is P1D-05.

function utcDate(yyyyMmDd: string): Date {
  return new Date(`${yyyyMmDd}T00:00:00Z`);
}

describe("creditCheckpoint — BR-25 nearest-preceding", () => {
  // start = 2026-01-01 → anchors at +90 (2026-04-01), +180 (2026-06-30),
  // +270 (2026-09-28), +365 (2027-01-01).
  const start = utcDate("2026-01-01");

  it("credits day 200 to the 180-day checkpoint — canonical FS F-05 example", () => {
    // Ticket Notes: "Make sure that exact case is the first assertion in the smoke test."
    expect(creditCheckpoint(start, utcDate("2026-07-20"))).toBe(180);
  });

  it("credits day 90 to the 90-day checkpoint (boundary on the lower anchor)", () => {
    expect(creditCheckpoint(start, utcDate("2026-04-01"))).toBe(90);
  });

  it("credits day 89 to no checkpoint (pre-90)", () => {
    expect(creditCheckpoint(start, utcDate("2026-03-31"))).toBeNull();
  });

  it("credits day 365 to the 365-day checkpoint (EC-16 boundary)", () => {
    expect(creditCheckpoint(start, utcDate("2027-01-01"))).toBe(365);
  });

  it("credits day 400 to the 365-day checkpoint (no cycle-2 anchor in v1)", () => {
    expect(creditCheckpoint(start, utcDate("2027-02-05"))).toBe(365);
  });

  it("credits day 270 to the 270-day checkpoint (third anchor boundary)", () => {
    expect(creditCheckpoint(start, utcDate("2026-09-28"))).toBe(270);
  });
});

describe("creditCheckpoint — null / pre-start guards", () => {
  it("returns null when aftercareStartDate is null (BR-32 / FS-12)", () => {
    expect(creditCheckpoint(null, utcDate("2026-07-20"))).toBeNull();
  });

  it("returns null when the visit predates the aftercare start", () => {
    expect(
      creditCheckpoint(utcDate("2026-01-01"), utcDate("2025-12-01")),
    ).toBeNull();
  });
});

describe("creditCheckpoint — UTC-day normalization (EC-19)", () => {
  it("normalizes a non-midnight visit Date to its UTC calendar day", () => {
    // EC-19 — Date objects with a non-midnight time component (e.g. coming
    // from a Salesforce timestamp) must be reduced to their UTC calendar
    // day before offset math, so the time portion can't tip the day count.
    // 2026-04-01T23:00:00Z is still UTC calendar day 2026-04-01 (= day 90
    // from a 2026-01-01 start), so this MUST credit 90, not the day-91-and-
    // a-bit boundary that wall-clock arithmetic would produce.
    expect(
      creditCheckpoint(
        new Date("2026-01-01T00:00:00Z"),
        new Date("2026-04-01T23:00:00Z"),
      ),
    ).toBe(90);
  });

  it("is pure / deterministic across repeated calls", () => {
    const result = creditCheckpoint(utcDate("2026-01-01"), utcDate("2026-07-20"));
    for (let i = 0; i < 25; i++) {
      expect(
        creditCheckpoint(utcDate("2026-01-01"), utcDate("2026-07-20")),
      ).toBe(result);
    }
  });
});
