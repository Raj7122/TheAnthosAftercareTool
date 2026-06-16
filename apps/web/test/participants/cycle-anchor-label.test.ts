import type { PerAnchorState } from "@anthos/api";
import { describe, expect, it } from "vitest";

import { cycleAnchorDisplay } from "../../app/participants/[id]/_lib/cycle-anchor-label";

// P1F-07 — per-anchor cycle row label + variant mapping. Strict BR-33
// five-state subset (`PerAnchorState`); no aggregate-only states reach this
// mapping by type. Mirrors the cycle-badge-label.test.ts style from P1D-04.

describe("cycleAnchorDisplay — BR-33 per-anchor five-state mapping", () => {
  it("renders 'Complete' with the green cycleComplete variant", () => {
    expect(cycleAnchorDisplay("complete")).toEqual({
      label: "Complete",
      variant: "cycleComplete",
    });
  });

  it("renders 'Due' with the orange cycleDue variant", () => {
    expect(cycleAnchorDisplay("due")).toEqual({
      label: "Due",
      variant: "cycleDue",
    });
  });

  it("renders 'Overdue' with the red cycleOverdue variant (freshest miss)", () => {
    expect(cycleAnchorDisplay("overdue")).toEqual({
      label: "Overdue",
      variant: "cycleOverdue",
    });
  });

  it("renders 'Catch-up' with the purple cycleCatchUp variant (BR-26 Option A)", () => {
    // BR-26 Option A: a missed anchor that sits behind a later one stays as
    // `catch_up`, not `overdue` — the distinction surfaces here via a
    // different variant and label even though both reflect uncredited misses.
    expect(cycleAnchorDisplay("catch_up")).toEqual({
      label: "Catch-up",
      variant: "cycleCatchUp",
    });
  });

  it("renders 'Future' with the muted variant (anchor not yet reached)", () => {
    expect(cycleAnchorDisplay("future")).toEqual({
      label: "Future",
      variant: "muted",
    });
  });

  it("BR-26 distinction: overdue and catch_up produce different variants", () => {
    // Belt-and-suspenders check on the DoD line item — multi-miss catch-up
    // MUST NOT collapse into the same Badge variant as the freshest miss.
    const overdue = cycleAnchorDisplay("overdue");
    const catchUp = cycleAnchorDisplay("catch_up");
    expect(overdue.variant).not.toBe(catchUp.variant);
    expect(overdue.label).not.toBe(catchUp.label);
  });

  it("covers every PerAnchorState value (exhaustiveness guard)", () => {
    // If a new state lands in PerAnchorState, this test fails to compile —
    // the switch in `cycleAnchorDisplay` is exhaustive over the union type.
    const states: PerAnchorState[] = [
      "complete",
      "due",
      "overdue",
      "catch_up",
      "future",
    ];
    for (const state of states) {
      const result = cycleAnchorDisplay(state);
      expect(result.label.length).toBeGreaterThan(0);
      expect(result.variant.length).toBeGreaterThan(0);
    }
  });
});
