import { describe, expect, it } from "vitest";

import { tierPillVariant } from "../../app/_components/participant/tier-pill-variant";

describe("tierPillVariant — P1H-05 TIER cell", () => {
  it("returns the Tier 1 filled-circle variant", () => {
    const v = tierPillVariant(1);
    expect(v).not.toBeNull();
    expect(v!.label).toBe("Act today");
    expect(v!.numeral).toBe("①");
    expect(v!.glyphShape).toBe("filled");
    expect(v!.pillClassName).toContain("bg-red-100");
  });

  it("returns the Tier 2 half-fill variant", () => {
    const v = tierPillVariant(2);
    expect(v).not.toBeNull();
    expect(v!.label).toBe("Act this week");
    expect(v!.numeral).toBe("②");
    expect(v!.glyphShape).toBe("half");
    expect(v!.pillClassName).toContain("bg-amber-100");
  });

  it("returns the Tier 3 ring variant", () => {
    const v = tierPillVariant(3);
    expect(v).not.toBeNull();
    expect(v!.label).toBe("Routine");
    expect(v!.numeral).toBe("③");
    expect(v!.glyphShape).toBe("ring");
    expect(v!.pillClassName).toContain("bg-slate-100");
  });

  it("returns null for a missing tier so the row renders an em-dash", () => {
    expect(tierPillVariant(null)).toBeNull();
  });

  it("returns null for tier numbers outside the declared 1..3 range", () => {
    // The engine emits floored-to-3 buckets per VR-06, so an out-of-range
    // tier shouldn't occur — but the helper degrades safely rather than
    // throwing on a corrupt DTO.
    expect(tierPillVariant(0)).toBeNull();
    expect(tierPillVariant(4)).toBeNull();
  });

  it("emits a definition + action-verb tooltip per tier", () => {
    expect(tierPillVariant(1)!.tooltip).toBe(
      "Tier 1: highest urgency — reach this participant today",
    );
    expect(tierPillVariant(2)!.tooltip).toBe(
      "Tier 2: elevated — schedule contact this week",
    );
    expect(tierPillVariant(3)!.tooltip).toBe(
      "Tier 3: no urgent signal — standard cadence",
    );
  });
});
