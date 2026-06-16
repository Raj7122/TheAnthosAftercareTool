import { describe, expect, it } from "vitest";

import { bucketTier, tierLabelFor } from "../../src/priority/index.js";

// Score-to-tier bucketing boundary convention: score AT a cutoff lands in
// the HIGHER tier (lower tier number). Documented in tier.ts.
describe("bucketTier (TR-PRIORITY-3 / VR-06)", () => {
  const thresholds = { tier1_min: 80, tier2_min: 50 };

  it("score equal to tier1_min → Tier 1 (boundary lands in higher tier)", () => {
    expect(bucketTier(80, thresholds)).toBe(1);
  });

  it("score one below tier1_min → Tier 2", () => {
    expect(bucketTier(79.99, thresholds)).toBe(2);
  });

  it("score equal to tier2_min → Tier 2", () => {
    expect(bucketTier(50, thresholds)).toBe(2);
  });

  it("score below all declared minimums → Tier N+1 fall-through", () => {
    expect(bucketTier(49.99, thresholds)).toBe(3);
  });

  it("very high score → Tier 1", () => {
    expect(bucketTier(1_000_000, thresholds)).toBe(1);
  });

  it("very low score → fall-through tier", () => {
    expect(bucketTier(-1000, thresholds)).toBe(3);
  });

  it("supports 4-tier configurations", () => {
    const fourTier = {
      tier1_min: 90,
      tier2_min: 60,
      tier3_min: 30,
    };
    expect(bucketTier(95, fourTier)).toBe(1);
    expect(bucketTier(75, fourTier)).toBe(2);
    expect(bucketTier(45, fourTier)).toBe(3);
    expect(bucketTier(10, fourTier)).toBe(4);
  });
});

describe("tierLabelFor", () => {
  it("maps standard tiers to spec-canonical labels (FS v1.12 F-02)", () => {
    expect(tierLabelFor(1)).toBe("Act today");
    expect(tierLabelFor(2)).toBe("Act this week");
    expect(tierLabelFor(3)).toBe("Routine");
  });

  it("falls back to 'Tier N' for non-standard tier numbers", () => {
    expect(tierLabelFor(4)).toBe("Tier 4");
    expect(tierLabelFor(7)).toBe("Tier 7");
  });
});
