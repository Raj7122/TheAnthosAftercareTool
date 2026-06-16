import { describe, expect, it } from "vitest";

import { computePriority } from "../../src/priority/index.js";
import { makeConfig, makeFactor, makeParticipant } from "./_fixtures.js";

// highestImpactFactor = max pointsContributed; deterministic tie-break by
// `key` ascending. Documented in compute.ts (pickHighestImpact).

describe("computePriority — highestImpactFactor selection", () => {
  it("picks the factor with the largest pointsContributed", () => {
    const out = computePriority({
      participant: makeParticipant(),
      configuration: makeConfig(),
      factors: [
        // 16 × 1.5 = 24
        makeFactor({ key: "days_since_last_contact", valueNumeric: 16 }),
        // 10 × 4.0 = 40 — wins
        makeFactor({ key: "failed_attempts", valueNumeric: 10 }),
      ],
    });
    expect(out.highestImpactFactor.key).toBe("failed_attempts");
    expect(out.highestImpactFactor.pointsContributed).toBe(40);
  });

  it("breaks ties by `key` ascending (deterministic)", () => {
    // Custom config so both factors produce the same points.
    const config = makeConfig({
      factorWeights: {
        additive: {
          alpha_factor: 2.0,
          bravo_factor: 2.0,
        },
        multiplicative_modifiers: {},
        overlap_caps: [],
      },
    });

    const out = computePriority({
      participant: makeParticipant(),
      configuration: config,
      factors: [
        // Listed in reverse alphabetical order; tie-break should still pick alpha.
        makeFactor({ key: "bravo_factor", valueNumeric: 5 }),
        makeFactor({ key: "alpha_factor", valueNumeric: 5 }),
      ],
    });
    expect(out.highestImpactFactor.key).toBe("alpha_factor");
  });

  // P0-05a — cap-aware selection. The engine feeds effective contributions
  // (cap winner: winningPoints − absorbedPoints; cap losers: 0) into
  // pickHighestImpact, so the Primary Factor label points at what actually
  // moved the score, not the strongest raw signal absorbed by the cap.

  it("picks an uncapped factor over a capped winner whose marginal effective is lower", () => {
    // Cap {alpha_capped=40, bravo_capped=30}: winner=alpha_capped,
    // winningPoints=40, absorbedPoints=30 → alpha_capped effective = 10.
    // Uncapped charlie_free=35 > 10, so it wins highest-impact.
    //
    // Regression guard: under the rejected raw-rule branch this assertion
    // would resolve to `alpha_capped` at 40 — that's the pre-P0-05a behavior
    // this test exists to prevent.
    const config = makeConfig({
      factorWeights: {
        additive: {
          alpha_capped: 1.0,
          bravo_capped: 1.0,
          charlie_free: 1.0,
        },
        multiplicative_modifiers: {},
        overlap_caps: [
          { factors: ["alpha_capped", "bravo_capped"], cap: 999 },
        ],
      },
    });

    const out = computePriority({
      participant: makeParticipant(),
      configuration: config,
      factors: [
        makeFactor({ key: "alpha_capped", valueNumeric: 40 }),
        makeFactor({ key: "bravo_capped", valueNumeric: 30 }),
        makeFactor({ key: "charlie_free", valueNumeric: 35 }),
      ],
    });

    expect(out.highestImpactFactor.key).toBe("charlie_free");
    expect(out.highestImpactFactor.pointsContributed).toBe(35);
    // Raw factors[] rows are unchanged (BR-12 transparency).
    expect(
      out.factors.find((f) => f.key === "alpha_capped")?.pointsContributed,
    ).toBe(40);
    expect(
      out.factors.find((f) => f.key === "bravo_capped")?.pointsContributed,
    ).toBe(30);
  });

  it("selects the cap winner by effective marginal when no uncapped factor beats it", () => {
    // Cap {alpha_capped=40, bravo_capped=30}, no uncapped factor present.
    // alpha_capped effective = 40 − 30 = 10, bravo_capped effective = 0.
    // The cap winner still wins highest-impact, but reported
    // pointsContributed is the effective marginal (10), NOT the raw 40 —
    // this is the field's new semantics as of P0-05a.
    const config = makeConfig({
      factorWeights: {
        additive: {
          alpha_capped: 1.0,
          bravo_capped: 1.0,
        },
        multiplicative_modifiers: {},
        overlap_caps: [
          { factors: ["alpha_capped", "bravo_capped"], cap: 999 },
        ],
      },
    });

    const out = computePriority({
      participant: makeParticipant(),
      configuration: config,
      factors: [
        makeFactor({ key: "alpha_capped", valueNumeric: 40 }),
        makeFactor({ key: "bravo_capped", valueNumeric: 30 }),
      ],
    });

    expect(out.highestImpactFactor.key).toBe("alpha_capped");
    expect(out.highestImpactFactor.pointsContributed).toBe(10);
    // priorityScore still reflects MAX-of-cap (40), unchanged from P0-05.
    expect(out.priorityScore).toBe(40);
    // Semantic-split guard: the SAME field name carries different meanings
    // on the two surfaces — `factors[]` rows stay raw (BR-12 transparency)
    // even though `highestImpactFactor.pointsContributed` is now effective.
    expect(
      out.factors.find((f) => f.key === "alpha_capped")?.pointsContributed,
    ).toBe(40);
    expect(
      out.factors.find((f) => f.key === "bravo_capped")?.pointsContributed,
    ).toBe(30);
  });
});
