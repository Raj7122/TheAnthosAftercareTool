import { describe, expect, it } from "vitest";

import { configurationSchema } from "../../src/config/index.js";
import {
  computePriority,
  ConfigValidationError,
  createBarrierTypeInvariant,
  createFailedAttemptsInvariant,
  createOpenRepairInvariant,
  getActiveInvariants,
} from "../../src/priority/index.js";

import {
  makeConfig,
  makeFactor,
  makeParticipant,
  makeSuppression,
} from "./_fixtures.js";

// P0-04a smoke tests — categorical Tier 1 invariants (BR-24/25/26,
// TR-PRIORITY-15/16/17). The full per-fixture matrix lives in P0-10a;
// these cases assert engine plumbing only.

describe("computePriority — BR-24 invariant floor (TR-PRIORITY-15)", () => {
  it("promotes to Tier 1 when failed_attempts ≥ threshold even with otherwise-Tier-3 factor math", () => {
    const out = computePriority({
      participant: makeParticipant(),
      configuration: makeConfig(),
      factors: [
        makeFactor({ key: "failed_attempts", valueNumeric: 4 }),
      ],
      invariants: [createFailedAttemptsInvariant({ threshold: 3 })],
    });

    expect(out.tier).toBe(1);
    expect(out.tierLabel).toBe("Act today");
    expect(out.triggeredInvariants).toHaveLength(1);
    expect(out.triggeredInvariants[0]).toEqual({
      invariantId: "BR-24",
      displayLabel: "Failed contact attempts ≥ threshold",
    });
  });

  it("does not promote when failed_attempts is below threshold", () => {
    const out = computePriority({
      participant: makeParticipant(),
      configuration: makeConfig({
        // Score lands the participant in Tier 3 (priorityScore = 2 < tier2_min).
        factorWeights: {
          additive: { failed_attempts: 1.0 },
          multiplicative_modifiers: {},
          overlap_caps: [],
        },
      }),
      factors: [
        makeFactor({ key: "failed_attempts", valueNumeric: 2 }),
      ],
      invariants: [createFailedAttemptsInvariant({ threshold: 3 })],
    });

    expect(out.tier).toBeGreaterThan(1);
    expect(out.triggeredInvariants).toEqual([]);
  });
});

describe("computePriority — invariants slot routing", () => {
  it("empty invariants list leaves tier unchanged and emits triggeredInvariants: []", () => {
    const out = computePriority({
      participant: makeParticipant(),
      configuration: makeConfig(),
      factors: [
        makeFactor({ key: "days_since_last_contact", valueNumeric: 16 }),
      ],
      invariants: [],
    });

    expect(out.triggeredInvariants).toEqual([]);
    // No floor: tier comes from factor math (16 * 1.5 = 24 → Tier 3 since
    // tier1_min=80, tier2_min=50 in makeConfig defaults).
    expect(out.tier).toBeGreaterThan(1);
  });

  it("omitting input.invariants behaves like an empty list (backward compatible)", () => {
    const out = computePriority({
      participant: makeParticipant(),
      configuration: makeConfig(),
      factors: [makeFactor({ key: "days_since_last_contact", valueNumeric: 16 })],
    });

    expect(out.triggeredInvariants).toEqual([]);
  });
});

describe("getActiveInvariants — fail-loud on unknown Barrier Type (TR-PRIORITY-17)", () => {
  it("throws VR_08_UNKNOWN_BARRIER_TYPE when the M-CONFIG mapping references a Type absent from the enum cache", () => {
    // BR-26 (habitability) is the only invariant still routed through
    // `barrier_type_to_invariant`; BR-25 pivoted onto `Repair__c` (P0-04e).
    const configWithMissingType = makeConfig({
      tierInvariants: {
        failed_attempts_tier1_threshold: 3,
        barrier_type_to_invariant: {
          "Habitability / building condition": {
            invariant_id: "BR-26",
            display_label: "Habitability Barrier",
          },
        },
        open_repair_invariant: null,
        invariant_override_suppression: true,
      },
    });
    const emptyCache: ReadonlySet<string> = new Set<string>();

    expect(() => getActiveInvariants(configWithMissingType, emptyCache))
      .toThrowError(ConfigValidationError);

    try {
      getActiveInvariants(configWithMissingType, emptyCache);
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigValidationError);
      if (err instanceof ConfigValidationError) {
        expect(err.code).toBe("VR_08_UNKNOWN_BARRIER_TYPE");
        expect(err.details["barrierType"]).toBe(
          "Habitability / building condition",
        );
      }
    }
  });

  it("constructs successfully when the mapping is empty (Demo Mode posture)", () => {
    const invariants = getActiveInvariants(
      makeConfig({
        tierInvariants: {
          failed_attempts_tier1_threshold: 3,
          barrier_type_to_invariant: {},
          open_repair_invariant: null,
          invariant_override_suppression: true,
        },
      }),
      new Set<string>(),
    );
    // Always includes BR-24; no barrier-type or open-repair invariants in Demo.
    expect(invariants).toHaveLength(1);
    expect(invariants[0]?.id).toBe("BR-24");
  });

  it("constructs successfully when every mapped Type is in the enum cache", () => {
    const invariants = getActiveInvariants(
      makeConfig({
        tierInvariants: {
          failed_attempts_tier1_threshold: 3,
          barrier_type_to_invariant: {
            "Habitability / building condition": {
              invariant_id: "BR-26",
              display_label: "Habitability Barrier",
            },
          },
          open_repair_invariant: null,
          invariant_override_suppression: true,
        },
      }),
      new Set<string>(["Habitability / building condition"]),
    );
    expect(invariants).toHaveLength(2);
    expect(invariants.map((i) => i.id).sort()).toEqual(["BR-24", "BR-26"]);
  });
});

// `createBarrierTypeInvariant` serves BR-26 (habitability) only — BR-25
// pivoted onto `Repair__c` via `createOpenRepairInvariant` (P0-04e).
describe("createBarrierTypeInvariant — defensive on hydration drift", () => {
  it("does not fire when participant.open_barriers is missing", () => {
    const invariant = createBarrierTypeInvariant({
      invariantId: "BR-26",
      barrierType: "Habitability / building condition",
      displayLabel: "Habitability Barrier",
    });
    const result = invariant.check(makeParticipant(), []);
    expect(result.triggered).toBe(false);
  });

  it("fires with triggeringRecordId when a matching Aftercare-stage barrier is present", () => {
    const invariant = createBarrierTypeInvariant({
      invariantId: "BR-26",
      barrierType: "Habitability / building condition",
      displayLabel: "Habitability Barrier",
    });
    const result = invariant.check(
      makeParticipant({
        open_barriers: [
          {
            id: "a0Bxx0000001ABC",
            type: "Habitability / building condition",
            stage: "Aftercare",
          },
        ],
      }),
      [],
    );
    expect(result.triggered).toBe(true);
    expect(result.triggeringRecordId).toBe("a0Bxx0000001ABC");
    expect(result.floorTier).toBe(1);
  });

  it("does not fire when the matching barrier is from a non-Aftercare stage", () => {
    const invariant = createBarrierTypeInvariant({
      invariantId: "BR-26",
      barrierType: "Habitability / building condition",
      displayLabel: "Habitability Barrier",
    });
    const result = invariant.check(
      makeParticipant({
        open_barriers: [
          {
            id: "a0Bxx0000001ABC",
            type: "Habitability / building condition",
            stage: "Intake",
          },
        ],
      }),
      [],
    );
    expect(result.triggered).toBe(false);
  });
});

describe("computePriority — TR-PRIORITY-18 invariant vs suppression", () => {
  it("emits suppressionOverride when an invariant fires for a Snoozed participant under the default direction", () => {
    const out = computePriority({
      participant: makeParticipant(),
      configuration: makeConfig(),
      factors: [makeFactor({ key: "failed_attempts", valueNumeric: 4 })],
      invariants: [createFailedAttemptsInvariant({ threshold: 3 })],
      suppression: makeSuppression(),
    });

    expect(out.tier).toBe(1);
    expect(out.suppressionOverride).toEqual({
      reason: "invariant_override_suppression",
      invariantIds: ["BR-24"],
    });
  });

  it("emits no suppressionOverride when the participant is not Snoozed (invariant still floors the tier)", () => {
    const out = computePriority({
      participant: makeParticipant(),
      configuration: makeConfig(),
      factors: [makeFactor({ key: "failed_attempts", valueNumeric: 4 })],
      invariants: [createFailedAttemptsInvariant({ threshold: 3 })],
      // No `suppression` input — Phase-0 callers default until Path C ratifies.
    });

    expect(out.tier).toBe(1);
    expect(out.suppressionOverride).toBeNull();
  });

  it("emits no suppressionOverride when no invariants fire on a Snoozed participant", () => {
    const out = computePriority({
      participant: makeParticipant(),
      configuration: makeConfig({
        factorWeights: {
          additive: { failed_attempts: 1.0 },
          multiplicative_modifiers: {},
          overlap_caps: [],
        },
      }),
      factors: [makeFactor({ key: "failed_attempts", valueNumeric: 1 })],
      invariants: [createFailedAttemptsInvariant({ threshold: 3 })],
      suppression: makeSuppression(),
    });

    expect(out.triggeredInvariants).toEqual([]);
    expect(out.suppressionOverride).toBeNull();
  });

  it("respects the reversed direction: invariant + Snoozed + override=false → no payload, but tier still floors", () => {
    const out = computePriority({
      participant: makeParticipant(),
      configuration: makeConfig({
        tierInvariants: {
          failed_attempts_tier1_threshold: 3,
          barrier_type_to_invariant: {},
          open_repair_invariant: null,
          invariant_override_suppression: false,
        },
      }),
      factors: [makeFactor({ key: "failed_attempts", valueNumeric: 4 })],
      invariants: [createFailedAttemptsInvariant({ threshold: 3 })],
      suppression: makeSuppression(),
    });

    expect(out.tier).toBe(1);
    expect(out.triggeredInvariants).toHaveLength(1);
    expect(out.suppressionOverride).toBeNull();
  });

  it("collects every triggered invariant id when multiple fire together", () => {
    const out = computePriority({
      participant: makeParticipant({
        open_barriers: [
          {
            id: "a0Bxx0000001ABC",
            type: "Habitability / building condition",
            stage: "Aftercare",
          },
        ],
      }),
      configuration: makeConfig(),
      factors: [makeFactor({ key: "failed_attempts", valueNumeric: 4 })],
      invariants: [
        createFailedAttemptsInvariant({ threshold: 3 }),
        createBarrierTypeInvariant({
          invariantId: "BR-26",
          barrierType: "Habitability / building condition",
          displayLabel: "Habitability Barrier",
        }),
      ],
      suppression: makeSuppression(),
    });

    expect(out.suppressionOverride).not.toBeNull();
    expect(out.suppressionOverride?.invariantIds).toEqual(["BR-24", "BR-26"]);
  });

  it("backfills the tierInvariants .default() fields when omitted from config input (zod default)", () => {
    const parsed = configurationSchema.parse({
      ...makeConfig(),
      // Strip both .default() fields from the input — exercise the zod
      // default branches. The persistence-layer jsonb default likewise omits
      // them, so this is the read path a stored config row takes.
      tierInvariants: {
        failed_attempts_tier1_threshold: 3,
        barrier_type_to_invariant: {},
      },
    });

    expect(parsed.tierInvariants.invariant_override_suppression).toBe(true);
    expect(parsed.tierInvariants.open_repair_invariant).toBeNull();
  });
});

// P0-04e — BR-25 pivoted off the Barriers picklist onto `Repair__c`. The
// invariant reads `participant.repairs[]`; it fires on ≥1 repair in a
// non-terminal status AND `preOrPostMoveIn === "Post Move-In"`.
describe("createOpenRepairInvariant — open-repair Tier 1 floor (BR-25, TR-PRIORITY-16)", () => {
  const invariant = createOpenRepairInvariant({
    invariantId: "BR-25",
    displayLabel: "Open Repair",
  });

  it("does not fire when participant.repairs is missing", () => {
    const result = invariant.check(makeParticipant(), []);
    expect(result.triggered).toBe(false);
    expect(result.label).toBe("Open Repair");
  });

  it("does not fire when participant.repairs is not an array (hydration drift)", () => {
    const result = invariant.check(
      makeParticipant({ repairs: "not-an-array" }),
      [],
    );
    expect(result.triggered).toBe(false);
  });

  it("does not fire on an empty repairs[]", () => {
    const result = invariant.check(makeParticipant({ repairs: [] }), []);
    expect(result.triggered).toBe(false);
  });

  it("fires with triggeringRecordId when an open Post-Move-In repair is present", () => {
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
  });

  it("does not fire when the only open repair is Pre-Move-In", () => {
    const result = invariant.check(
      makeParticipant({
        repairs: [
          {
            id: "a5RU8000000RP3IAQ",
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
          { status: "Completed", preOrPostMoveIn: "Post Move-In" },
          { status: "Canceled", preOrPostMoveIn: "Post Move-In" },
        ],
      }),
      [],
    );
    expect(result.triggered).toBe(false);
  });

  it("fires off the first matching repair when an earlier repair is closed", () => {
    const result = invariant.check(
      makeParticipant({
        repairs: [
          {
            id: "closed",
            status: "Completed",
            preOrPostMoveIn: "Post Move-In",
          },
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

  it("fires without triggeringRecordId when the matching repair has a non-string id", () => {
    const result = invariant.check(
      makeParticipant({
        repairs: [{ status: "Repairing", preOrPostMoveIn: "Post Move-In" }],
      }),
      [],
    );
    expect(result.triggered).toBe(true);
    expect(result.triggeringRecordId).toBeUndefined();
  });
});

// AC-14 — a participant whose factor math lands Tier 3 but who has one open
// Post-Move-In repair MUST be floored to Tier 1, and the repair MUST surface
// in `triggeredInvariants[]` as the Primary Factor (EC-12 / TR-PRIORITY-7).
describe("computePriority — BR-25 open-repair invariant floor (AC-14)", () => {
  it("promotes to Tier 1 on an open Post-Move-In repair even with otherwise-Tier-3 factor math", () => {
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
      // days_since_last_contact = 1 → score 1.5 → Tier 3 (tier2_min = 50).
      factors: [makeFactor({ key: "days_since_last_contact", valueNumeric: 1 })],
      invariants: [
        createOpenRepairInvariant({
          invariantId: "BR-25",
          displayLabel: "Open Repair",
        }),
      ],
    });

    expect(out.tier).toBe(1);
    expect(out.tierLabel).toBe("Act today");
    expect(out.triggeredInvariants).toHaveLength(1);
    expect(out.triggeredInvariants[0]).toEqual({
      invariantId: "BR-25",
      displayLabel: "Open Repair",
      triggeringRecordId: "a5RU8000000RP1IAQ",
    });
  });

  it("does not promote when the only repair is terminal (factor math stands)", () => {
    const out = computePriority({
      participant: makeParticipant({
        repairs: [
          {
            id: "a5RU8000000RP2IAQ",
            status: "Completed",
            preOrPostMoveIn: "Post Move-In",
          },
        ],
      }),
      configuration: makeConfig(),
      factors: [makeFactor({ key: "days_since_last_contact", valueNumeric: 2 })],
      invariants: [
        createOpenRepairInvariant({
          invariantId: "BR-25",
          displayLabel: "Open Repair",
        }),
      ],
    });

    expect(out.tier).toBeGreaterThan(1);
    expect(out.triggeredInvariants).toEqual([]);
  });
});

// P0-04e — `getActiveInvariants` constructs BR-25 from the
// `open_repair_invariant` config block, independent of the
// `barrier_type_to_invariant` (BR-26) path.
describe("getActiveInvariants — open-repair invariant config block (P0-04e)", () => {
  it("constructs the BR-25 open-repair invariant when the config block is present", () => {
    const invariants = getActiveInvariants(
      makeConfig({
        tierInvariants: {
          failed_attempts_tier1_threshold: 3,
          barrier_type_to_invariant: {},
          open_repair_invariant: {
            invariant_id: "BR-25",
            display_label: "Open Repair",
          },
          invariant_override_suppression: true,
        },
      }),
      new Set<string>(),
    );
    expect(invariants.map((i) => i.id)).toEqual(["BR-24", "BR-25"]);
  });

  it("skips BR-25 when the open_repair_invariant block is null (Demo Mode)", () => {
    const invariants = getActiveInvariants(
      makeConfig({
        tierInvariants: {
          failed_attempts_tier1_threshold: 3,
          barrier_type_to_invariant: {},
          open_repair_invariant: null,
          invariant_override_suppression: true,
        },
      }),
      new Set<string>(),
    );
    expect(invariants.map((i) => i.id)).toEqual(["BR-24"]);
  });

  it("orders the invariant set BR-24, BR-25, then the BR-26 barrier-type entries", () => {
    const invariants = getActiveInvariants(
      makeConfig({
        tierInvariants: {
          failed_attempts_tier1_threshold: 3,
          barrier_type_to_invariant: {
            "Habitability / building condition": {
              invariant_id: "BR-26",
              display_label: "Habitability Barrier",
            },
          },
          open_repair_invariant: {
            invariant_id: "BR-25",
            display_label: "Open Repair",
          },
          invariant_override_suppression: true,
        },
      }),
      new Set<string>(["Habitability / building condition"]),
    );
    // Order is load-bearing (TR-PRIORITY-4) — assert the array, not a sort.
    expect(invariants.map((i) => i.id)).toEqual(["BR-24", "BR-25", "BR-26"]);
  });
});

