import { tierLabelFor } from "@anthos/domain";
import { describe, expect, it } from "vitest";

import { tierLabel } from "../../app/participants/[id]/_lib/tier-label";

describe("tierLabel — P1F-08 SPA-side parity with caseload `tierLabel`", () => {
  it("returns null when the engine had no scored output (currentTier=null)", () => {
    expect(tierLabel(null)).toBeNull();
  });

  it.each([1, 2, 3] as const)(
    "delegates to `@anthos/domain`'s `tierLabelFor` for tier %i (spec-canonical labels)",
    (tier) => {
      expect(tierLabel(tier)).toBe(tierLabelFor(tier));
    },
  );

  it("returns the canonical FS v1.12 §F-02 labels", () => {
    expect(tierLabel(1)).toBe("Act today");
    expect(tierLabel(2)).toBe("Act this week");
    expect(tierLabel(3)).toBe("Routine");
  });

  it("returns null for out-of-range tier numbers (engine contract is 1..3)", () => {
    expect(tierLabel(0)).toBeNull();
    expect(tierLabel(4)).toBeNull();
    expect(tierLabel(-1)).toBeNull();
  });
});
