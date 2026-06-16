import { describe, expect, it } from "vitest";

import {
  computePriority,
  createBarrierTypeInvariant,
  createFailedAttemptsInvariant,
} from "../../src/priority/index.js";
import {
  BR19_FACTOR_KEYS,
  makeAllBR19Factors,
  makeConfig,
  makeBR19Config,
  makeFactor,
  makeParticipant,
} from "./_fixtures.js";

// TR-PRIORITY-7 + API v1.3 §7.3.1: every breakdown row must contain
// name, valueLabel, valueNumeric, weight, pointsContributed.
describe("computePriority — breakdown payload shape (TR-PRIORITY-7, BR-12)", () => {
  it("emits one factors[] row per supplied Factor (BR-12 / AC-12)", () => {
    const out = computePriority({
      participant: makeParticipant(),
      configuration: makeConfig(),
      factors: [
        makeFactor({ key: "days_since_last_contact", valueNumeric: 16 }),
        makeFactor({ key: "failed_attempts", valueNumeric: 2 }),
      ],
    });
    expect(out.factors).toHaveLength(2);
  });

  it("each factors[] row has all required fields", () => {
    const out = computePriority({
      participant: makeParticipant(),
      configuration: makeConfig(),
      factors: [
        makeFactor({
          key: "days_since_last_contact",
          displayName: "Days since last successful contact",
          valueLabel: "16 days",
          valueNumeric: 16,
        }),
      ],
    });

    const row = out.factors[0];
    expect(row).toBeDefined();
    if (row === undefined) return;

    expect(row.name).toBe("Days since last successful contact");
    expect(row.key).toBe("days_since_last_contact");
    expect(row.valueLabel).toBe("16 days");
    expect(row.valueNumeric).toBe(16);
    expect(row.weight).toBe("1.5×"); // formatWeight(1.5) per API §7.3.1
    expect(row.weightRaw).toBe(1.5);
    expect(row.pointsContributed).toBe(24); // 16 × 1.5
  });

  it("priorityScore equals the sum of pointsContributed when no overlap caps are configured", () => {
    // BR-22 cap (P0-05) changes this invariant: when overlap_caps fire, the
    // engine aggregates listed factors with MAX, not SUM, so priorityScore
    // can be < sum(pointsContributed). The base no-cap path tested here still
    // holds, since makeConfig() ships with `overlap_caps: []`.
    const out = computePriority({
      participant: makeParticipant(),
      configuration: makeConfig(),
      factors: [
        makeFactor({ key: "days_since_last_contact", valueNumeric: 16 }),
        makeFactor({ key: "failed_attempts", valueNumeric: 2 }),
      ],
    });
    // 16 × 1.5 = 24; 2 × 4.0 = 8; sum = 32
    expect(out.priorityScore).toBe(32);
  });

  it("highestImpactFactor.key matches one of the contribution keys", () => {
    const out = computePriority({
      participant: makeParticipant(),
      configuration: makeConfig(),
      factors: [
        makeFactor({ key: "days_since_last_contact", valueNumeric: 16 }),
        makeFactor({ key: "failed_attempts", valueNumeric: 2 }),
      ],
    });
    const keys = out.factors.map((f) => f.key);
    expect(keys).toContain(out.highestImpactFactor.key);
  });

  it("emits participantId on the output", () => {
    const out = computePriority({
      participant: makeParticipant({ participantId: "0035g00000ZZZAA" }),
      configuration: makeConfig(),
      factors: [makeFactor({ key: "days_since_last_contact", valueNumeric: 16 })],
    });
    expect(out.participantId).toBe("0035g00000ZZZAA");
  });

  // BR-12 transparency: a factor whose valueNumeric is exactly 0 still
  // surfaces in factors[]. Silently filtering zero contributions would
  // hide calibration-relevant signals from specialists.
  it("preserves an explicit-zero contribution in factors[] (BR-12)", () => {
    const out = computePriority({
      participant: makeParticipant(),
      configuration: makeConfig(),
      factors: [
        makeFactor({ key: "days_since_last_contact", valueNumeric: 16 }),
        makeFactor({ key: "failed_attempts", valueNumeric: 0 }),
      ],
    });

    expect(out.factors).toHaveLength(2);
    const failed = out.factors.find((f) => f.key === "failed_attempts");
    expect(failed).toBeDefined();
    if (failed === undefined) return;
    expect(failed.valueNumeric).toBe(0);
    expect(failed.pointsContributed).toBe(0);
  });
});

// BR-19 (a–i): the engine MUST route every BR-19 factor key through to the
// breakdown payload with the canonical shape. Per-factor internal logic
// lives in P0-04; this test asserts engine plumbing only.
describe("computePriority — BR-19 factor coverage (a–i) (TR-PRIORITY-7)", () => {
  it("emits one factors[] row per BR-19 key when all 9 are supplied", () => {
    const out = computePriority({
      participant: makeParticipant(),
      configuration: makeBR19Config(),
      factors: makeAllBR19Factors(),
    });

    expect(out.factors).toHaveLength(BR19_FACTOR_KEYS.length);
    const emittedKeys = out.factors.map((f) => f.key).sort();
    expect(emittedKeys).toEqual([...BR19_FACTOR_KEYS].sort());
  });

  it("every BR-19 row has the canonical breakdown shape (API §7.3.1)", () => {
    const out = computePriority({
      participant: makeParticipant(),
      configuration: makeBR19Config(),
      factors: makeAllBR19Factors(),
    });

    for (const key of BR19_FACTOR_KEYS) {
      const row = out.factors.find((f) => f.key === key);
      expect(row, `expected factors[] to include row for ${key}`).toBeDefined();
      if (row === undefined) continue;
      expect(typeof row.name).toBe("string");
      expect(row.name.length).toBeGreaterThan(0);
      expect(typeof row.valueLabel).toBe("string");
      expect(typeof row.valueNumeric).toBe("number");
      expect(Number.isFinite(row.valueNumeric)).toBe(true);
      expect(typeof row.weight).toBe("string");
      expect(typeof row.weightRaw).toBe("number");
      expect(typeof row.pointsContributed).toBe("number");
      expect(row.pointsContributed).toBe(row.valueNumeric * row.weightRaw);
    }
  });
});

// NEW (v1.2) — TRD v1.8 §1787: the per-factor breakdown payload's invariant
// arm. `triggered_invariants[]` carries `{invariant_id, display_label,
// triggering_record_id}` so F-02 EC-12 can label the invariant (not the
// highest-weighted factor) as the "Primary Factor" when an invariant fires
// on a participant whose factor math alone would score Tier 3. These tests
// are the breakdown-payload contract — `compute.invariants.test.ts` covers
// the floor mechanic separately.
describe("computePriority — triggered_invariants[] breakdown payload (TR-PRIORITY-7 v1.2, EC-12)", () => {
  it("emits an empty array when no invariants fire", () => {
    const out = computePriority({
      participant: makeParticipant(),
      configuration: makeConfig(),
      factors: [makeFactor({ key: "days_since_last_contact", valueNumeric: 16 })],
      invariants: [],
    });

    expect(out.triggeredInvariants).toEqual([]);
  });

  it("emits a single entry with {invariantId, displayLabel} when one invariant fires (aggregate — no triggeringRecordId)", () => {
    const out = computePriority({
      participant: makeParticipant(),
      configuration: makeConfig(),
      factors: [makeFactor({ key: "failed_attempts", valueNumeric: 4 })],
      invariants: [createFailedAttemptsInvariant({ threshold: 3 })],
    });

    expect(out.triggeredInvariants).toHaveLength(1);
    expect(out.triggeredInvariants[0]).toEqual({
      invariantId: "BR-24",
      displayLabel: "Failed contact attempts ≥ threshold",
    });
  });

  it("emits multiple entries in input order when multiple invariants fire (BR-25 carries triggeringRecordId)", () => {
    const out = computePriority({
      participant: makeParticipant({
        open_barriers: [
          { id: "a0Bxx0000001ABC", type: "Repair pending", stage: "Aftercare" },
        ],
      }),
      configuration: makeConfig(),
      factors: [makeFactor({ key: "failed_attempts", valueNumeric: 4 })],
      // Order matters: apply-tier-floors.ts preserves input order on the
      // triggered list. Reverse this array and the assertion below would flip.
      invariants: [
        createFailedAttemptsInvariant({ threshold: 3 }),
        createBarrierTypeInvariant({
          invariantId: "BR-25",
          barrierType: "Repair pending",
          displayLabel: "Open Repair Barrier",
        }),
      ],
    });

    expect(out.triggeredInvariants).toHaveLength(2);
    expect(out.triggeredInvariants.map((t) => t.invariantId)).toEqual([
      "BR-24",
      "BR-25",
    ]);
    expect(out.triggeredInvariants[0]).toEqual({
      invariantId: "BR-24",
      displayLabel: "Failed contact attempts ≥ threshold",
    });
    expect(out.triggeredInvariants[1]).toEqual({
      invariantId: "BR-25",
      displayLabel: "Open Repair Barrier",
      triggeringRecordId: "a0Bxx0000001ABC",
    });
  });
});
