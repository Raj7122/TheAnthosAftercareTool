import { describe, expect, it } from "vitest";

import {
  computePriority,
  createOpenRepairInvariant,
} from "../../../src/priority/index.js";
import { makeConfig, makeFactor, makeParticipant } from "../_fixtures.js";

// P0-10a — NEW (v1.2). BR-25 / TR-PRIORITY-16 categorical Tier 1 invariant
// matrix. BR-25 floors a participant to Tier 1 when ≥1 open Post-Move-In
// repair exists. Floor-not-cap: factor math may score higher, never lower.
//
// Data source: P0-04e pivoted BR-25 off the Barriers picklist onto the
// dedicated `Repair__c` object (Julia 2026-05-19); `createOpenRepairInvariant`
// reads `participant.repairs[]` — each entry `{ id?, status?, preOrPostMoveIn? }`.
// The P0-10a ticket's AC#2 ("`Repair pending` Barrier Type fixture") predates
// that pivot and is stale; per the merged code these fixtures use synthetic
// `Repair__c` rows. P0-08h carries the matching FS/TRD erratum.
//
// `compute.invariants.test.ts` carries the P0-04a engine-plumbing smoke tests;
// this file is the full per-fixture matrix the P0-10a ticket calls for.

describe("createOpenRepairInvariant — check() matrix (BR-25)", () => {
  const invariant = createOpenRepairInvariant({
    invariantId: "BR-25",
    displayLabel: "Open Repair",
  });

  it("fires on one open Post-Move-In repair, returning its record id", () => {
    const result = invariant.check(
      makeParticipant({
        repairs: [
          {
            id: "a5RU8000000RP1IAQ",
            status: "Repairing",
            preOrPostMoveIn: "Post Move-In",
          },
        ],
      }),
      [],
    );
    expect(result.triggered).toBe(true);
    expect(result.triggeringRecordId).toBe("a5RU8000000RP1IAQ");
    expect(result.floorTier).toBe(1);
    expect(result.label).toBe("Open Repair");
  });

  it("does not fire when participant.repairs is absent", () => {
    expect(invariant.check(makeParticipant(), []).triggered).toBe(false);
  });

  it("does not fire when participant.repairs is not an array (hydration drift)", () => {
    expect(
      invariant.check(makeParticipant({ repairs: "not-an-array" }), [])
        .triggered,
    ).toBe(false);
  });

  it("does not fire on an empty repairs[]", () => {
    expect(
      invariant.check(makeParticipant({ repairs: [] }), []).triggered,
    ).toBe(false);
  });

  it("does not fire when the only open repair is Pre-Move-In", () => {
    const result = invariant.check(
      makeParticipant({
        repairs: [
          {
            id: "r1",
            status: "Need Identified",
            preOrPostMoveIn: "Pre Move-In",
          },
        ],
      }),
      [],
    );
    expect(result.triggered).toBe(false);
  });

  it("does not fire when every Post-Move-In repair is in a terminal status", () => {
    const result = invariant.check(
      makeParticipant({
        repairs: [
          { id: "r1", status: "Completed", preOrPostMoveIn: "Post Move-In" },
          { id: "r2", status: "Canceled", preOrPostMoveIn: "Post Move-In" },
        ],
      }),
      [],
    );
    expect(result.triggered).toBe(false);
  });

  it("fires off the first open Post-Move-In repair, skipping earlier closed ones", () => {
    const result = invariant.check(
      makeParticipant({
        repairs: [
          { id: "closed", status: "Completed", preOrPostMoveIn: "Post Move-In" },
          {
            id: "open",
            status: "Collecting Bids",
            preOrPostMoveIn: "Post Move-In",
          },
        ],
      }),
      [],
    );
    expect(result.triggered).toBe(true);
    expect(result.triggeringRecordId).toBe("open");
  });

  it("fires without a triggeringRecordId when the matching repair has no string id", () => {
    const result = invariant.check(
      makeParticipant({
        repairs: [{ status: "Repairing", preOrPostMoveIn: "Post Move-In" }],
      }),
      [],
    );
    expect(result.triggered).toBe(true);
    expect(result.triggeringRecordId).toBeUndefined();
  });

  it("skips entries whose status is not a string (hydration drift)", () => {
    const result = invariant.check(
      makeParticipant({
        repairs: [
          { id: "drift", status: 123, preOrPostMoveIn: "Post Move-In" },
          { id: "valid", status: "Repairing", preOrPostMoveIn: "Post Move-In" },
        ],
      }),
      [],
    );
    expect(result.triggered).toBe(true);
    expect(result.triggeringRecordId).toBe("valid");
  });

  it("treats an unknown non-terminal status as open and fires (Q-R1 default-open)", () => {
    const result = invariant.check(
      makeParticipant({
        repairs: [
          {
            id: "r1",
            status: "Ready for Final Inspection",
            preOrPostMoveIn: "Post Move-In",
          },
        ],
      }),
      [],
    );
    expect(result.triggered).toBe(true);
  });

  it("honors a custom floorTier", () => {
    const custom = createOpenRepairInvariant({
      invariantId: "BR-25",
      displayLabel: "Open Repair",
      floorTier: 2,
    });
    const result = custom.check(
      makeParticipant({
        repairs: [
          { id: "r1", status: "Repairing", preOrPostMoveIn: "Post Move-In" },
        ],
      }),
      [],
    );
    expect(result.floorTier).toBe(2);
  });
});

// AC-14 — synthesize a participant whose factor math lands Tier 3, attach the
// BR-25 triggering signal, and assert the engine floors output to Tier 1 with
// the repair surfaced as a labeled `triggeredInvariants[]` contribution.
describe("computePriority — BR-25 Tier 1 floor end-to-end (AC-14)", () => {
  const openRepair = createOpenRepairInvariant({
    invariantId: "BR-25",
    displayLabel: "Open Repair",
  });

  it("floors an otherwise-Tier-3 participant with one open Post-Move-In repair to Tier 1", () => {
    const out = computePriority({
      participant: makeParticipant({
        repairs: [
          {
            id: "a5RU8000000RP1IAQ",
            status: "Repairing",
            preOrPostMoveIn: "Post Move-In",
          },
        ],
      }),
      configuration: makeConfig(),
      // 1 × 1.5 = 1.5 → below tier2_min (50) → Tier 3 on factor math alone.
      factors: [makeFactor({ key: "days_since_last_contact", valueNumeric: 1 })],
      invariants: [openRepair],
    });

    expect(out.tier).toBe(1);
    expect(out.tierLabel).toBe("Act today");
    expect(out.triggeredInvariants).toEqual([
      {
        invariantId: "BR-25",
        displayLabel: "Open Repair",
        triggeringRecordId: "a5RU8000000RP1IAQ",
      },
    ]);
  });

  it("leaves the factor-math tier untouched when the only repair is terminal", () => {
    const out = computePriority({
      participant: makeParticipant({
        repairs: [
          { id: "r1", status: "Completed", preOrPostMoveIn: "Post Move-In" },
        ],
      }),
      configuration: makeConfig(),
      factors: [makeFactor({ key: "days_since_last_contact", valueNumeric: 1 })],
      invariants: [openRepair],
    });

    expect(out.tier).toBe(3);
    expect(out.triggeredInvariants).toEqual([]);
  });
});
