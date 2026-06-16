import { describe, expect, it } from "vitest";

import {
  computeWeightedAgreement,
  type CalibrationItem,
} from "../../src/calibration/index.js";

// TR-PRIORITY-10 / BR-23 — asymmetric weighted agreement metric.
//   score = A / (A + α·FP + β·FN)
// Classification (per FS v1.12 BR-23):
//   A  ← (Tier 1|2 + "yes")  ∪  (Tier 3 + "no")
//   FP ← (Tier 1|2 + "no")
//   FN ← (Tier 3 + "yes")

function item(
  engineTier: number,
  specialistJudgment: "yes" | "no",
): CalibrationItem {
  return { engineTier, specialistJudgment };
}

function repeat<T>(n: number, factory: () => T): T[] {
  return Array.from({ length: n }, factory);
}

describe("computeWeightedAgreement — TR-PRIORITY-10 / BR-23", () => {
  it("perfect agreement → score 1.0, no FP, no FN", () => {
    const items: CalibrationItem[] = [
      ...repeat(5, () => item(1, "yes")),
      ...repeat(3, () => item(2, "yes")),
      ...repeat(2, () => item(3, "no")),
    ];

    const result = computeWeightedAgreement(items, 1.0, 2.0);

    expect(result.score).toBe(1.0);
    expect(result.agreements).toBe(10);
    expect(result.falsePositives).toBe(0);
    expect(result.falseNegatives).toBe(0);
  });

  it("all FP (Tier 1/2 + 'no') → score reflects α-only denominator", () => {
    const items: CalibrationItem[] = [
      ...repeat(3, () => item(1, "no")),
      ...repeat(2, () => item(2, "no")),
    ];

    const result = computeWeightedAgreement(items, 1.0, 2.0);

    expect(result.score).toBe(0);
    expect(result.agreements).toBe(0);
    expect(result.falsePositives).toBe(5);
    expect(result.falseNegatives).toBe(0);
  });

  it("all FN (Tier 3 + 'yes') → score reflects β-only denominator", () => {
    const items: CalibrationItem[] = repeat(3, () => item(3, "yes"));

    const result = computeWeightedAgreement(items, 1.0, 2.0);

    expect(result.score).toBe(0);
    expect(result.agreements).toBe(0);
    expect(result.falsePositives).toBe(0);
    expect(result.falseNegatives).toBe(3);
  });

  // BR-23 worked example 1 (FS v1.12 line 512): 15-participant session,
  // 12 agreements + 2 FP + 1 FN, α=1, β=2 → 12/(12+2+2) = 0.75.
  it("BR-23 worked example: 12A + 2FP + 1FN, α=1, β=2 → 0.75", () => {
    const items: CalibrationItem[] = [
      ...repeat(12, () => item(1, "yes")),
      item(1, "no"),
      item(2, "no"),
      item(3, "yes"),
    ];

    const result = computeWeightedAgreement(items, 1.0, 2.0);

    expect(result.score).toBeCloseTo(0.75, 4);
    expect(result.agreements).toBe(12);
    expect(result.falsePositives).toBe(2);
    expect(result.falseNegatives).toBe(1);
  });

  // BR-23 worked example 2: 12 agreements + 0 FP + 3 FN, α=1, β=2 →
  // 12/(12+0+6) = 0.6667. FN-heavy session scores worse than the previous
  // case despite identical flat-agreement count.
  it("BR-23 worked example: 12A + 0FP + 3FN, α=1, β=2 → 0.6667", () => {
    const items: CalibrationItem[] = [
      ...repeat(12, () => item(1, "yes")),
      ...repeat(3, () => item(3, "yes")),
    ];

    const result = computeWeightedAgreement(items, 1.0, 2.0);

    expect(result.score).toBeCloseTo(12 / 18, 4);
    expect(result.agreements).toBe(12);
    expect(result.falsePositives).toBe(0);
    expect(result.falseNegatives).toBe(3);
  });

  it("classifies Tier 2 + 'yes' as agreement (not FP)", () => {
    const result = computeWeightedAgreement([item(2, "yes")], 1.0, 2.0);
    expect(result.agreements).toBe(1);
    expect(result.falsePositives).toBe(0);
    expect(result.score).toBe(1.0);
  });

  it("classifies Tier 1 + 'no' as FP (not FN)", () => {
    const result = computeWeightedAgreement([item(1, "no")], 1.0, 2.0);
    expect(result.falsePositives).toBe(1);
    expect(result.falseNegatives).toBe(0);
  });

  // Custom-weight path — every other case uses the BR-23 defaults (α=1, β=2).
  // Hand-computed: 8A + 4FP + 2FN, α=0.5, β=3.0
  //   denom = 8 + 0.5·4 + 3.0·2 = 8 + 2 + 6 = 16; score = 8/16 = 0.5.
  // Catches accidental transposition of α and β, which the asymmetry test
  // below would miss because it only asserts a `<` relation.
  it("honours custom α and β weights: 8A + 4FP + 2FN, α=0.5, β=3.0 → 0.5", () => {
    const items: CalibrationItem[] = [
      ...repeat(8, () => item(1, "yes")),
      ...repeat(4, () => item(1, "no")),
      ...repeat(2, () => item(3, "yes")),
    ];

    const result = computeWeightedAgreement(items, 0.5, 3.0);

    expect(result.score).toBeCloseTo(0.5, 6);
    expect(result.agreements).toBe(8);
    expect(result.falsePositives).toBe(4);
    expect(result.falseNegatives).toBe(2);
  });

  it("β > α makes an FN-heavy session score lower than an FP-heavy one with the same totals", () => {
    const fpHeavy = computeWeightedAgreement(
      [...repeat(5, () => item(1, "yes")), ...repeat(3, () => item(1, "no"))],
      1.0,
      2.0,
    );
    const fnHeavy = computeWeightedAgreement(
      [...repeat(5, () => item(1, "yes")), ...repeat(3, () => item(3, "yes"))],
      1.0,
      2.0,
    );

    expect(fnHeavy.score).toBeLessThan(fpHeavy.score);
  });

  it("is deterministic: same input + same weights → identical result", () => {
    const items: CalibrationItem[] = [
      item(1, "yes"),
      item(3, "no"),
      item(2, "no"),
      item(3, "yes"),
    ];

    const first = computeWeightedAgreement(items, 1.0, 2.0);
    const second = computeWeightedAgreement(items, 1.0, 2.0);

    expect(second).toEqual(first);
  });

  it("does not mutate its inputs", () => {
    const items: CalibrationItem[] = [item(1, "yes"), item(3, "no")];
    const snapshot = JSON.parse(JSON.stringify(items));
    computeWeightedAgreement(items, 1.0, 2.0);
    expect(JSON.parse(JSON.stringify(items))).toEqual(snapshot);
  });

  it("throws on empty input (floor enforcement lives in the caller)", () => {
    expect(() => computeWeightedAgreement([], 1.0, 2.0)).toThrow(
      /at least one item/,
    );
  });

  it("throws on negative alpha", () => {
    expect(() => computeWeightedAgreement([item(1, "yes")], -0.5, 2.0)).toThrow(
      /alpha/,
    );
  });

  it("throws on negative beta", () => {
    expect(() => computeWeightedAgreement([item(1, "yes")], 1.0, -1)).toThrow(
      /beta/,
    );
  });

  // Zero α erases the FP penalty (defeats half of BR-23); zero β erases the
  // FN penalty (defeats the asymmetry the metric exists to enforce); α=β=0
  // collapses the denominator to A and silently returns 1.0 for any non-
  // trivial session. Reject all three at the boundary.
  it("throws on zero alpha", () => {
    expect(() => computeWeightedAgreement([item(1, "yes")], 0, 2.0)).toThrow(
      /alpha/,
    );
  });

  it("throws on zero beta", () => {
    expect(() => computeWeightedAgreement([item(1, "yes")], 1.0, 0)).toThrow(
      /beta/,
    );
  });

  it("throws on non-finite alpha", () => {
    expect(() =>
      computeWeightedAgreement([item(1, "yes")], Number.NaN, 2.0),
    ).toThrow(/alpha/);
    expect(() =>
      computeWeightedAgreement([item(1, "yes")], Number.POSITIVE_INFINITY, 2.0),
    ).toThrow(/alpha/);
  });

  it("throws on non-finite beta", () => {
    expect(() =>
      computeWeightedAgreement([item(1, "yes")], 1.0, Number.NaN),
    ).toThrow(/beta/);
  });

  it("throws on an engineTier outside {1, 2, 3}", () => {
    expect(() =>
      computeWeightedAgreement([{ engineTier: 0, specialistJudgment: "yes" }], 1.0, 2.0),
    ).toThrow(/engineTier/);
    expect(() =>
      computeWeightedAgreement([{ engineTier: 4, specialistJudgment: "no" }], 1.0, 2.0),
    ).toThrow(/engineTier/);
  });

  it("throws on an invalid specialistJudgment crossing a JSON/DB boundary", () => {
    expect(() =>
      computeWeightedAgreement(
        // Simulate untyped data from a calibration-session import.
        [{ engineTier: 1, specialistJudgment: "maybe" as "yes" }],
        1.0,
        2.0,
      ),
    ).toThrow(/specialistJudgment/);
  });
});
