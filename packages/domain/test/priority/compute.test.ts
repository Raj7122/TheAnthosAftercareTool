import { describe, expect, it } from "vitest";

import { computePriority } from "../../src/priority/index.js";
import {
  makeConfig,
  makeBR19Config,
  makeFactor,
  makeParticipant,
} from "./_fixtures.js";

// TR-PRIORITY-4 (BR-17): same input + same config version → same output.
describe("computePriority — determinism (TR-PRIORITY-4, BR-17)", () => {
  it("produces identical EngineOutput across repeated calls", () => {
    const input = {
      participant: makeParticipant(),
      configuration: makeConfig(),
      factors: [
        makeFactor({ key: "days_since_last_contact", valueNumeric: 16 }),
        makeFactor({ key: "failed_attempts", valueNumeric: 2 }),
      ],
    };

    const first = computePriority(input);
    for (let i = 0; i < 100; i++) {
      expect(computePriority(input)).toStrictEqual(first);
    }
  });

  it("output.configurationVersion mirrors input.configuration.version", () => {
    const out = computePriority({
      participant: makeParticipant(),
      configuration: makeConfig({ version: 42 }),
      factors: [makeFactor({ key: "days_since_last_contact", valueNumeric: 16 })],
    });
    expect(out.configurationVersion).toBe(42);
  });

  it("emits triggeredInvariants: [] when no invariants supplied (TR-PRIORITY-7 v1.2)", () => {
    const out = computePriority({
      participant: makeParticipant(),
      configuration: makeConfig(),
      factors: [makeFactor({ key: "days_since_last_contact", valueNumeric: 16 })],
    });
    expect(out.triggeredInvariants).toEqual([]);
  });

  it("emits priorityModifier: null when factor (h) aftercare_extended is absent or 0", () => {
    const out = computePriority({
      participant: makeParticipant(),
      configuration: makeConfig(),
      factors: [makeFactor({ key: "days_since_last_contact", valueNumeric: 16 })],
    });
    expect(out.priorityModifier).toBeNull();
  });

  it("emits priorityModifier label when factor (h) aftercare_extended contributes (>0)", () => {
    const out = computePriority({
      participant: makeParticipant(),
      configuration: makeConfig({
        factorWeights: {
          additive: { aftercare_extended: 1.25 },
          multiplicative_modifiers: {},
          overlap_caps: [],
        },
      }),
      factors: [makeFactor({ key: "aftercare_extended", valueNumeric: 1 })],
    });
    // One-decimal format keeps integer weights visually aligned with the
    // breakdown row's `weight` field (which uses formatWeight()).
    expect(out.priorityModifier).toBe("Aftercare Extended (×1.3)");
  });

  it("pads integer-valued weights to one decimal in priorityModifier (×1.0)", () => {
    const out = computePriority({
      participant: makeParticipant(),
      configuration: makeConfig({
        factorWeights: {
          additive: { aftercare_extended: 1.0 },
          multiplicative_modifiers: {},
          overlap_caps: [],
        },
      }),
      factors: [makeFactor({ key: "aftercare_extended", valueNumeric: 1 })],
    });
    expect(out.priorityModifier).toBe("Aftercare Extended (×1.0)");
  });

  it("emits priorityModifier: null when factor (h) is present but value is 0", () => {
    const out = computePriority({
      participant: makeParticipant(),
      configuration: makeConfig({
        factorWeights: {
          additive: { aftercare_extended: 1.25 },
          multiplicative_modifiers: {},
          overlap_caps: [],
        },
      }),
      factors: [makeFactor({ key: "aftercare_extended", valueNumeric: 0 })],
    });
    expect(out.priorityModifier).toBeNull();
  });

  // Strengthens the BR-17 idempotency AC: identical factor inputs across two
  // configs with the same weights but distinct `version` numbers MUST produce
  // identical priorityScore, while configurationVersion faithfully reflects
  // the input. Surfaces any accidental cross-version state leakage.
  it("priorityScore is identical across configs with same weights / distinct versions; configurationVersion mirrors input", () => {
    const factors = [
      makeFactor({ key: "days_since_last_contact", valueNumeric: 16 }),
      makeFactor({ key: "failed_attempts", valueNumeric: 2 }),
    ];
    const outV7 = computePriority({
      participant: makeParticipant(),
      configuration: makeConfig({ version: 7 }),
      factors,
    });
    const outV8 = computePriority({
      participant: makeParticipant(),
      configuration: makeConfig({ version: 8 }),
      factors,
    });

    expect(outV7.priorityScore).toBe(outV8.priorityScore);
    expect(outV7.configurationVersion).toBe(7);
    expect(outV8.configurationVersion).toBe(8);
  });
});

// BR-21 / Pattern F — engine plumbing only. Pattern F binds the
// zero-contribution invariant to the SBOP *factor function* (which P0-04
// lands as a stub returning 0 while sbop_enabled=false); the engine merely
// routes whatever Factor it is handed. This suite asserts that routing:
// when a Factor with key='sbop' returns valueNumeric=0, the breakdown row
// surfaces with pointsContributed=0 and remains deterministic across
// repeated calls. The factor stub here is NOT a substitute for Pattern F
// — it stands in for the real P0-04 stub so the engine wiring is provable
// today; the Pattern F invariant gets its own test alongside the factor.
describe("computePriority — BR-21 SBOP engine plumbing (Pattern F)", () => {
  it("emits sbop row with pointsContributed=0 when sbopEnabled=false", () => {
    const out = computePriority({
      participant: makeParticipant(),
      configuration: makeBR19Config({ sbopEnabled: false }),
      // The stub Factor returns 0 here; in production the factor function
      // (P0-04 deliverable) reads the sbop_enabled flag and returns 0 when
      // it is false. Engine routing is identical regardless.
      factors: [makeFactor({ key: "sbop", valueNumeric: 0 })],
    });

    expect(out.factors).toHaveLength(1);
    const sbop = out.factors[0];
    expect(sbop).toBeDefined();
    if (sbop === undefined) return;
    expect(sbop.key).toBe("sbop");
    expect(sbop.valueNumeric).toBe(0);
    expect(sbop.pointsContributed).toBe(0);
    expect(out.priorityScore).toBe(0);
  });

  it("remains deterministic across 100 calls with sbopEnabled=false", () => {
    const input = {
      participant: makeParticipant(),
      configuration: makeBR19Config({ sbopEnabled: false }),
      factors: [makeFactor({ key: "sbop", valueNumeric: 0 })],
    };
    const first = computePriority(input);
    for (let i = 0; i < 100; i++) {
      expect(computePriority(input)).toStrictEqual(first);
    }
  });
});
