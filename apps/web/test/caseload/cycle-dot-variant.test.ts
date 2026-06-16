import { describe, expect, it } from "vitest";

import { cycleDotVariant } from "../../app/_components/participant/cycle-dot-variant";

describe("cycleDotVariant — P1H-05 STABILITY CYCLE dot mapping", () => {
  it("renders the green check for a credited (complete) anchor", () => {
    const v = cycleDotVariant(90, "complete");
    expect(v.className).toContain("bg-cycleComplete");
    expect(v.glyph).toBe("✓");
    expect(v.ariaLabel).toBe("90-day checkpoint: complete");
  });

  it("renders the orange dot for a due anchor", () => {
    const v = cycleDotVariant(180, "due");
    expect(v.className).toContain("bg-cycleDue");
    expect(v.glyph).toBe("•");
    expect(v.ariaLabel).toBe("180-day checkpoint: due");
  });

  it("renders the red × for an overdue anchor (distinct glyph from catch_up per BR-33 colorblind)", () => {
    const v = cycleDotVariant(270, "overdue");
    expect(v.className).toContain("bg-cycleOverdue");
    expect(v.glyph).toBe("×");
    expect(v.ariaLabel).toBe("270-day checkpoint: overdue");
  });

  it("renders the purple bang for a catch-up anchor", () => {
    const v = cycleDotVariant(365, "catch_up");
    expect(v.className).toContain("bg-cycleCatchUp");
    expect(v.glyph).toBe("!");
    expect(v.ariaLabel).toBe("365-day checkpoint: catch-up");
  });

  it("uses distinct glyphs for overdue vs. catch_up so red/purple are distinguishable without color", () => {
    expect(cycleDotVariant(270, "overdue").glyph).not.toBe(
      cycleDotVariant(270, "catch_up").glyph,
    );
  });

  it("renders a hollow circle for a future anchor", () => {
    const v = cycleDotVariant(180, "future");
    expect(v.className).toContain("bg-white");
    expect(v.className).toContain("border");
    expect(v.glyph).toBe("");
    expect(v.ariaLabel).toBe("180-day checkpoint: future");
  });

  it("emits per-anchor × per-state action-anchored tooltips", () => {
    // One representative per state — anchor parameterization is uniform.
    expect(cycleDotVariant(90, "complete").tooltip).toBe(
      "90-day visit completed",
    );
    expect(cycleDotVariant(180, "due").tooltip).toBe(
      "180-day visit due soon — schedule it",
    );
    expect(cycleDotVariant(270, "overdue").tooltip).toBe(
      "270-day visit overdue — schedule make-up",
    );
    expect(cycleDotVariant(365, "catch_up").tooltip).toBe(
      "365-day visit missed — catch-up required",
    );
    expect(cycleDotVariant(90, "future").tooltip).toBe(
      "90-day visit: not yet reached",
    );
  });
});
