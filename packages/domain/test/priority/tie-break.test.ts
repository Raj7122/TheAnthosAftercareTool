import { describe, expect, it } from "vitest";

import { compareTieBreak } from "../../src/priority/index.js";
import type { RankableParticipant } from "../../src/priority/index.js";

// TR-PRIORITY-13 / EC-05 — when two participants share tier + score, order
// resolves by (a) oldest `mostRecentSuccessfulContactAt` first, then
// (b) participant ID ascending. Determinism is non-negotiable: shuffled
// inputs must sort to the same final order every run.

function row(
  participantId: string,
  mostRecentSuccessfulContactAt: Date | null,
): RankableParticipant {
  return { participantId, mostRecentSuccessfulContactAt };
}

describe("compareTieBreak — TR-PRIORITY-13 / EC-05", () => {
  it("ranks the older contact date first (AC: tie on score → oldest contact wins)", () => {
    const older = row("p_alpha", new Date("2026-01-01T00:00:00Z"));
    const newer = row("p_beta", new Date("2026-05-01T00:00:00Z"));
    expect(compareTieBreak(older, newer)).toBe(-1);
    expect(compareTieBreak(newer, older)).toBe(1);
  });

  it("falls back to participant ID ascending when contact dates tie (AC: tie on score + date → lower ID wins)", () => {
    const sameDate = new Date("2026-03-15T00:00:00Z");
    const lowerId = row("0035g00000AAA0001", sameDate);
    const higherId = row("0035g00000ZZZ9999", sameDate);
    expect(compareTieBreak(lowerId, higherId)).toBe(-1);
    expect(compareTieBreak(higherId, lowerId)).toBe(1);
  });

  it("treats a null contact date as oldest (TR-PRIORITY-14: null = infinite days since)", () => {
    const neverContacted = row("p_null", null);
    const recentlyContacted = row("p_recent", new Date("2026-05-01T00:00:00Z"));
    expect(compareTieBreak(neverContacted, recentlyContacted)).toBe(-1);
    expect(compareTieBreak(recentlyContacted, neverContacted)).toBe(1);
  });

  it("falls back to participant ID when both contact dates are null", () => {
    const lower = row("p_aaa", null);
    const higher = row("p_zzz", null);
    expect(compareTieBreak(lower, higher)).toBe(-1);
    expect(compareTieBreak(higher, lower)).toBe(1);
  });

  it("returns 0 only when participant IDs match", () => {
    const sameDate = new Date("2026-03-15T00:00:00Z");
    const a = row("p_same", sameDate);
    const b = row("p_same", sameDate);
    expect(compareTieBreak(a, b)).toBe(0);
  });

  it("is deterministic: shuffled input → identical sorted output every run", () => {
    const rows: RankableParticipant[] = [
      row("p_03", new Date("2026-01-15T00:00:00Z")),
      row("p_01", new Date("2026-01-15T00:00:00Z")), // same date as p_03 → ID breaks
      row("p_07", null), // null → sorts first
      row("p_02", new Date("2025-11-30T00:00:00Z")), // oldest concrete
      row("p_04", new Date("2026-04-01T00:00:00Z")),
      row("p_05", null),
      row("p_06", new Date("2026-04-01T00:00:00Z")),
    ];

    const expected = [...rows].sort(compareTieBreak).map((r) => r.participantId);
    // Sanity-check the manual ordering: nulls first (by ID), then by date asc
    // (with ID tiebreak within identical dates).
    expect(expected).toEqual([
      "p_05",
      "p_07",
      "p_02",
      "p_01",
      "p_03",
      "p_04",
      "p_06",
    ]);

    for (let i = 0; i < 100; i++) {
      const shuffled = [...rows].sort(() => Math.random() - 0.5);
      const sorted = shuffled.sort(compareTieBreak).map((r) => r.participantId);
      expect(sorted).toEqual(expected);
    }
  });

  it("does not mutate its arguments", () => {
    const a = row("p_a", new Date("2026-01-01T00:00:00Z"));
    const b = row("p_b", new Date("2026-02-01T00:00:00Z"));
    const snapshotA = JSON.parse(JSON.stringify(a));
    const snapshotB = JSON.parse(JSON.stringify(b));
    compareTieBreak(a, b);
    compareTieBreak(b, a);
    expect(JSON.parse(JSON.stringify(a))).toEqual(snapshotA);
    expect(JSON.parse(JSON.stringify(b))).toEqual(snapshotB);
  });
});
