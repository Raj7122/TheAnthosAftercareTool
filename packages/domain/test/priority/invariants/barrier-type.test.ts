import { describe, expect, it } from "vitest";

import {
  computePriority,
  createBarrierTypeInvariant,
} from "../../../src/priority/index.js";
import { makeConfig, makeFactor, makeParticipant } from "../_fixtures.js";

// P0-10a — NEW (v1.2). BR-26 / TR-PRIORITY-17 categorical Tier 1 invariant
// matrix. BR-26 floors a participant to Tier 1 when ≥1 open Barrier of the
// configured `Type` and `Stage='Aftercare'` exists. Floor-not-cap: factor
// math may score higher, never lower.
//
// `createBarrierTypeInvariant` reads `participant.open_barriers[]` — each
// entry `{ id?, type?, stage? }`. The fixtures here synthesize the
// `Habitability / building condition` Barrier Type; the engine never reads
// the live Salesforce picklist (Immutable #1). Engine-construction fail-loud
// against the picklist enum cache is exercised in `invariant-registry.test.ts`.
//
// `compute.invariants.test.ts` carries the P0-04a engine-plumbing smoke tests;
// this file is the full per-fixture matrix the P0-10a ticket calls for.

const HABITABILITY_TYPE = "Habitability / building condition";

describe("createBarrierTypeInvariant — check() matrix (BR-26)", () => {
  const invariant = createBarrierTypeInvariant({
    invariantId: "BR-26",
    barrierType: HABITABILITY_TYPE,
    displayLabel: "Habitability Barrier",
  });

  it("fires on a matching Barrier Type at Aftercare stage, returning its record id", () => {
    const result = invariant.check(
      makeParticipant({
        open_barriers: [
          { id: "a0Bxx0000001ABC", type: HABITABILITY_TYPE, stage: "Aftercare" },
        ],
      }),
      [],
    );
    expect(result.triggered).toBe(true);
    expect(result.triggeringRecordId).toBe("a0Bxx0000001ABC");
    expect(result.floorTier).toBe(1);
    expect(result.label).toBe("Habitability Barrier");
  });

  it("does not fire when participant.open_barriers is absent", () => {
    expect(invariant.check(makeParticipant(), []).triggered).toBe(false);
  });

  it("does not fire when participant.open_barriers is not an array (hydration drift)", () => {
    expect(
      invariant.check(makeParticipant({ open_barriers: "not-an-array" }), [])
        .triggered,
    ).toBe(false);
  });

  it("does not fire on an empty open_barriers[]", () => {
    expect(
      invariant.check(makeParticipant({ open_barriers: [] }), []).triggered,
    ).toBe(false);
  });

  it("does not fire when the matching Barrier Type is at a non-Aftercare stage", () => {
    const result = invariant.check(
      makeParticipant({
        open_barriers: [
          { id: "b1", type: HABITABILITY_TYPE, stage: "Intake" },
        ],
      }),
      [],
    );
    expect(result.triggered).toBe(false);
  });

  it("does not fire on a non-matching Barrier Type at Aftercare stage", () => {
    const result = invariant.check(
      makeParticipant({
        open_barriers: [
          { id: "b1", type: "Benefits / entitlements", stage: "Aftercare" },
        ],
      }),
      [],
    );
    expect(result.triggered).toBe(false);
  });

  it("fires off the first matching barrier, skipping earlier non-matching ones", () => {
    const result = invariant.check(
      makeParticipant({
        open_barriers: [
          { id: "other", type: "Benefits / entitlements", stage: "Aftercare" },
          { id: "match", type: HABITABILITY_TYPE, stage: "Aftercare" },
        ],
      }),
      [],
    );
    expect(result.triggered).toBe(true);
    expect(result.triggeringRecordId).toBe("match");
  });

  it("fires without a triggeringRecordId when the matching barrier has no string id", () => {
    const result = invariant.check(
      makeParticipant({
        open_barriers: [{ type: HABITABILITY_TYPE, stage: "Aftercare" }],
      }),
      [],
    );
    expect(result.triggered).toBe(true);
    expect(result.triggeringRecordId).toBeUndefined();
  });

  it("honors a custom floorTier", () => {
    const custom = createBarrierTypeInvariant({
      invariantId: "BR-26",
      barrierType: HABITABILITY_TYPE,
      displayLabel: "Habitability Barrier",
      floorTier: 2,
    });
    const result = custom.check(
      makeParticipant({
        open_barriers: [
          { id: "b1", type: HABITABILITY_TYPE, stage: "Aftercare" },
        ],
      }),
      [],
    );
    expect(result.floorTier).toBe(2);
  });
});

// AC-14 — synthesize a participant whose factor math lands Tier 3, attach the
// BR-26 triggering signal, and assert the engine floors output to Tier 1 with
// the barrier surfaced as a labeled `triggeredInvariants[]` contribution.
describe("computePriority — BR-26 Tier 1 floor end-to-end (AC-14)", () => {
  const habitability = createBarrierTypeInvariant({
    invariantId: "BR-26",
    barrierType: HABITABILITY_TYPE,
    displayLabel: "Habitability Barrier",
  });

  it("floors an otherwise-Tier-3 participant with an Aftercare-stage habitability barrier to Tier 1", () => {
    const out = computePriority({
      participant: makeParticipant({
        open_barriers: [
          { id: "a0Bxx0000001ABC", type: HABITABILITY_TYPE, stage: "Aftercare" },
        ],
      }),
      configuration: makeConfig(),
      // 1 × 1.5 = 1.5 → below tier2_min (50) → Tier 3 on factor math alone.
      factors: [makeFactor({ key: "days_since_last_contact", valueNumeric: 1 })],
      invariants: [habitability],
    });

    expect(out.tier).toBe(1);
    expect(out.tierLabel).toBe("Act today");
    expect(out.triggeredInvariants).toEqual([
      {
        invariantId: "BR-26",
        displayLabel: "Habitability Barrier",
        triggeringRecordId: "a0Bxx0000001ABC",
      },
    ]);
  });

  it("leaves the factor-math tier untouched when the barrier is at a non-Aftercare stage", () => {
    const out = computePriority({
      participant: makeParticipant({
        open_barriers: [
          { id: "b1", type: HABITABILITY_TYPE, stage: "Intake" },
        ],
      }),
      configuration: makeConfig(),
      factors: [makeFactor({ key: "days_since_last_contact", valueNumeric: 1 })],
      invariants: [habitability],
    });

    expect(out.tier).toBe(3);
    expect(out.triggeredInvariants).toEqual([]);
  });
});
