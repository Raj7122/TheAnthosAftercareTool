import { describe, expect, it } from "vitest";

import {
  applyOverlapCaps,
  computePriority,
} from "../../src/priority/index.js";
import type { FactorContribution } from "../../src/priority/index.js";
import { makeConfig, makeFactor, makeParticipant } from "./_fixtures.js";

// BR-22 / TR-PRIORITY-9 — the engine MUST cap overlapping unreachability
// signals as MAX of factor contributions, not SUM. Per-factor breakdown rows
// stay raw (BR-12 transparency); aggregation reflects the cap.

function makeContribution(
  key: string,
  pointsContributed: number,
): FactorContribution {
  return {
    name: key,
    key,
    valueLabel: `${pointsContributed}`,
    valueNumeric: pointsContributed,
    weight: "1×",
    weightRaw: 1,
    pointsContributed,
  };
}

describe("applyOverlapCaps — pure-function unit (BR-22)", () => {
  it("returns SUM with no triggered caps when overlap_caps is empty", () => {
    const contributions = [
      makeContribution("a", 12),
      makeContribution("b", 8),
    ];
    const result = applyOverlapCaps(contributions, []);
    expect(result.effectiveScore).toBe(20);
    expect(result.triggeredCaps).toEqual([]);
  });

  it("does not fire a cap when only one of the listed factors is present", () => {
    const contributions = [
      makeContribution("cannot_reach_barrier", 12),
      makeContribution("other", 5),
    ];
    const result = applyOverlapCaps(contributions, [
      { factors: ["cannot_reach_barrier", "failed_attempts"], cap: 99 },
    ]);
    expect(result.effectiveScore).toBe(17);
    expect(result.triggeredCaps).toEqual([]);
  });

  it("collapses two overlapping factors to MAX, not SUM", () => {
    // raw SUM = 12 + 8 = 20; MAX = 12; absorbed = 8
    const contributions = [
      makeContribution("cannot_reach_barrier", 12),
      makeContribution("failed_attempts", 8),
    ];
    const result = applyOverlapCaps(contributions, [
      { factors: ["cannot_reach_barrier", "failed_attempts"], cap: 99 },
    ]);
    expect(result.effectiveScore).toBe(12);
    expect(result.triggeredCaps).toHaveLength(1);
    const cap = result.triggeredCaps[0];
    expect(cap).toBeDefined();
    if (cap === undefined) return;
    expect(cap.winningFactor).toBe("cannot_reach_barrier");
    expect(cap.winningPoints).toBe(12);
    expect(cap.absorbedPoints).toBe(8);
    expect(cap.presentFactors).toEqual([
      "cannot_reach_barrier",
      "failed_attempts",
    ]);
  });

  it("applies cap only to the overlapping subset; other factors keep summing", () => {
    // Capped pair: A=12, B=8 → contribution = MAX = 12.
    // C is outside the cap and sums normally.
    const contributions = [
      makeContribution("cannot_reach_barrier", 12),
      makeContribution("failed_attempts", 8),
      makeContribution("days_since_last_contact", 5),
    ];
    const result = applyOverlapCaps(contributions, [
      { factors: ["cannot_reach_barrier", "failed_attempts"], cap: 99 },
    ]);
    expect(result.effectiveScore).toBe(17); // 12 + 5
    expect(result.triggeredCaps).toHaveLength(1);
  });

  it("breaks ties inside a cap by lexicographically smaller key", () => {
    const contributions = [
      makeContribution("zeta_barrier", 10),
      makeContribution("alpha_attempts", 10),
    ];
    const result = applyOverlapCaps(contributions, [
      { factors: ["zeta_barrier", "alpha_attempts"], cap: 99 },
    ]);
    expect(result.effectiveScore).toBe(10);
    const cap = result.triggeredCaps[0];
    expect(cap).toBeDefined();
    if (cap === undefined) return;
    expect(cap.winningFactor).toBe("alpha_attempts");
    expect(cap.absorbedPoints).toBe(10);
  });

  it("is pure: does not mutate the input contributions array", () => {
    const contributions = [
      makeContribution("a", 12),
      makeContribution("b", 8),
    ];
    const snapshot = JSON.parse(JSON.stringify(contributions));
    applyOverlapCaps(contributions, [
      { factors: ["a", "b"], cap: 99 },
    ]);
    expect(JSON.parse(JSON.stringify(contributions))).toEqual(snapshot);
  });
});

// Engine-level wiring: computePriority threads the cap through and exposes
// `triggeredCaps` on EngineOutput while leaving `factors[]` rows untouched.
describe("computePriority — BR-22 wiring", () => {
  it("emits triggeredCaps: [] when no cap fires", () => {
    const out = computePriority({
      participant: makeParticipant(),
      configuration: makeConfig(),
      factors: [
        makeFactor({ key: "days_since_last_contact", valueNumeric: 16 }),
        makeFactor({ key: "failed_attempts", valueNumeric: 2 }),
      ],
    });
    expect(out.triggeredCaps).toEqual([]);
    // priorityScore still equals the raw SUM in the no-cap path.
    const rawSum = out.factors.reduce((s, f) => s + f.pointsContributed, 0);
    expect(out.priorityScore).toBe(rawSum);
  });

  it("collapses two capped factors to MAX while preserving raw factor rows", () => {
    // failed_attempts weight=4.0; days_since_last_contact weight=1.5.
    // valueNumeric chosen so failed_attempts.pointsContributed > the other.
    const config = makeConfig({
      factorWeights: {
        additive: {
          days_since_last_contact: 1.5,
          failed_attempts: 4.0,
        },
        multiplicative_modifiers: {},
        overlap_caps: [
          {
            factors: ["days_since_last_contact", "failed_attempts"],
            cap: 999,
          },
        ],
      },
    });

    const out = computePriority({
      participant: makeParticipant(),
      configuration: config,
      factors: [
        // 16 × 1.5 = 24
        makeFactor({ key: "days_since_last_contact", valueNumeric: 16 }),
        // 10 × 4.0 = 40 — wins MAX
        makeFactor({ key: "failed_attempts", valueNumeric: 10 }),
      ],
    });

    // Raw rows untouched: each shows its own pointsContributed.
    expect(out.factors).toHaveLength(2);
    const days = out.factors.find(
      (f) => f.key === "days_since_last_contact",
    );
    const fails = out.factors.find((f) => f.key === "failed_attempts");
    expect(days?.pointsContributed).toBe(24);
    expect(fails?.pointsContributed).toBe(40);

    // priorityScore = MAX(24, 40) = 40, NOT 64.
    expect(out.priorityScore).toBe(40);

    // Transparency: cap is reported.
    expect(out.triggeredCaps).toHaveLength(1);
    const cap = out.triggeredCaps[0];
    expect(cap).toBeDefined();
    if (cap === undefined) return;
    expect(cap.winningFactor).toBe("failed_attempts");
    expect(cap.winningPoints).toBe(40);
    expect(cap.absorbedPoints).toBe(24);
  });

  it("is deterministic under BR-17 / TR-PRIORITY-4 when a cap fires", () => {
    const config = makeConfig({
      factorWeights: {
        additive: {
          days_since_last_contact: 1.5,
          failed_attempts: 4.0,
        },
        multiplicative_modifiers: {},
        overlap_caps: [
          {
            factors: ["days_since_last_contact", "failed_attempts"],
            cap: 999,
          },
        ],
      },
    });
    const input = {
      participant: makeParticipant(),
      configuration: config,
      factors: [
        makeFactor({ key: "days_since_last_contact", valueNumeric: 16 }),
        makeFactor({ key: "failed_attempts", valueNumeric: 10 }),
      ],
    };

    const first = computePriority(input);
    for (let i = 0; i < 100; i++) {
      expect(computePriority(input)).toStrictEqual(first);
    }
  });
});
