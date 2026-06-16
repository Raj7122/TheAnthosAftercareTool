import { describe, expect, it } from "vitest";

import {
  BR_24_FACTOR_KEY,
  BR_24_INVARIANT_ID,
  computePriority,
  createFailedAttemptsInvariant,
} from "../../../src/priority/index.js";
import type { FactorContribution } from "../../../src/priority/index.js";
import { makeConfig, makeFactor, makeParticipant } from "../_fixtures.js";

// P0-10a — NEW (v1.2). BR-24 / TR-PRIORITY-15 categorical Tier 1 invariant
// matrix. BR-24 floors a participant to Tier 1 when failed contact attempts in
// the current cycle reach `failed_attempts_tier1_threshold`. Floor-not-cap:
// factor math may score higher, never lower. The invariant reads the
// `failed_attempts` value off the per-factor contribution row so the floor
// fires off the exact number the breakdown shows (BR-12 transparency).
//
// `compute.invariants.test.ts` carries the P0-04a engine-plumbing smoke tests;
// this file is the full per-fixture matrix the P0-10a ticket calls for.

// Minimal FactorContribution row for direct invariant `.check()` calls — the
// invariant only reads `key` + `valueNumeric`; the rest satisfy the type.
// Kept local: `_fixtures.ts` is P0-10 scaffolding and stays untouched.
function makeContribution(
  key: string,
  valueNumeric: number,
): FactorContribution {
  return {
    name: key,
    key,
    valueLabel: `${valueNumeric}`,
    valueNumeric,
    weight: "1.0×",
    weightRaw: 1,
    pointsContributed: valueNumeric,
  };
}

describe("createFailedAttemptsInvariant — check() matrix (BR-24)", () => {
  const invariant = createFailedAttemptsInvariant({ threshold: 3 });

  it("reports BR-24 as its invariant id", () => {
    expect(invariant.id).toBe(BR_24_INVARIANT_ID);
  });

  it("fires when failed_attempts equals the threshold exactly", () => {
    const result = invariant.check(makeParticipant(), [
      makeContribution(BR_24_FACTOR_KEY, 3),
    ]);
    expect(result.triggered).toBe(true);
    expect(result.floorTier).toBe(1);
  });

  it("fires when failed_attempts exceeds the threshold", () => {
    const result = invariant.check(makeParticipant(), [
      makeContribution(BR_24_FACTOR_KEY, 9),
    ]);
    expect(result.triggered).toBe(true);
  });

  it("does not fire when failed_attempts is one below the threshold", () => {
    const result = invariant.check(makeParticipant(), [
      makeContribution(BR_24_FACTOR_KEY, 2),
    ]);
    expect(result.triggered).toBe(false);
  });

  it("does not fire when no failed_attempts contribution row is present (defaults to 0)", () => {
    const result = invariant.check(makeParticipant(), [
      makeContribution("days_since_last_contact", 99),
    ]);
    expect(result.triggered).toBe(false);
  });

  it("does not fire when the failed_attempts value is non-finite (NaN guard)", () => {
    const result = invariant.check(makeParticipant(), [
      makeContribution(BR_24_FACTOR_KEY, Number.NaN),
    ]);
    expect(result.triggered).toBe(false);
  });

  it("never emits a triggeringRecordId — BR-24 is an aggregate invariant", () => {
    const result = invariant.check(makeParticipant(), [
      makeContribution(BR_24_FACTOR_KEY, 4),
    ]);
    expect(result.triggeringRecordId).toBeUndefined();
  });

  it("honors a custom displayLabel and floorTier", () => {
    const custom = createFailedAttemptsInvariant({
      threshold: 3,
      displayLabel: "Three strikes",
      floorTier: 2,
    });
    const result = custom.check(makeParticipant(), [
      makeContribution(BR_24_FACTOR_KEY, 5),
    ]);
    expect(result.label).toBe("Three strikes");
    expect(result.floorTier).toBe(2);
  });
});

// AC-14 — synthesize a participant whose factor math lands Tier 3, attach the
// BR-24 triggering signal, and assert the engine floors output to Tier 1 with
// the invariant surfaced as a labeled `triggeredInvariants[]` contribution.
describe("computePriority — BR-24 Tier 1 floor end-to-end (AC-14)", () => {
  it("floors an otherwise-Tier-3 participant to Tier 1 and labels the invariant", () => {
    const out = computePriority({
      participant: makeParticipant(),
      configuration: makeConfig(),
      // 4 × 4.0 = 16 → below tier2_min (50) → Tier 3 on factor math alone.
      factors: [makeFactor({ key: "failed_attempts", valueNumeric: 4 })],
      invariants: [createFailedAttemptsInvariant({ threshold: 3 })],
    });

    expect(out.tier).toBe(1);
    expect(out.tierLabel).toBe("Act today");
    expect(out.triggeredInvariants).toEqual([
      {
        invariantId: "BR-24",
        displayLabel: "Failed contact attempts ≥ threshold",
      },
    ]);
  });

  it("leaves the factor-math tier untouched when failed_attempts is below threshold", () => {
    const out = computePriority({
      participant: makeParticipant(),
      configuration: makeConfig(),
      // 2 × 4.0 = 8 → Tier 3; threshold 3 not reached → no floor.
      factors: [makeFactor({ key: "failed_attempts", valueNumeric: 2 })],
      invariants: [createFailedAttemptsInvariant({ threshold: 3 })],
    });

    expect(out.tier).toBe(3);
    expect(out.triggeredInvariants).toEqual([]);
  });

  it("is floor-not-cap — a participant already scoring Tier 1 stays Tier 1", () => {
    const out = computePriority({
      participant: makeParticipant(),
      configuration: makeConfig(),
      // 25 × 4.0 = 100 ≥ tier1_min (80) → Tier 1 on factor math alone.
      factors: [makeFactor({ key: "failed_attempts", valueNumeric: 25 })],
      invariants: [createFailedAttemptsInvariant({ threshold: 3 })],
    });

    expect(out.tier).toBe(1);
    // The invariant still fires and surfaces — it just did not move the tier.
    expect(out.triggeredInvariants).toHaveLength(1);
    expect(out.triggeredInvariants[0]?.invariantId).toBe("BR-24");
  });
});
