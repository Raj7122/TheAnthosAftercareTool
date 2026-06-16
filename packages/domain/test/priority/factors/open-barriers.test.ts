import { describe, expect, it } from "vitest";

import { openBarriersFactor } from "../../../src/priority/factors/open-barriers.js";
import { makeConfig, makeParticipant } from "../_fixtures.js";

const baseConfig = makeConfig();

describe("BR-19(e) — open_barriers factor", () => {
  it("returns 0 for an empty array", () => {
    const result = openBarriersFactor.compute(
      makeParticipant({ open_barriers: [] }),
      baseConfig,
    );
    expect(result).toEqual({ valueLabel: "0 open", valueNumeric: 0 });
  });

  it("returns 0 for missing field", () => {
    const result = openBarriersFactor.compute(makeParticipant(), baseConfig);
    expect(result.valueNumeric).toBe(0);
  });

  it("sums per-severity configured weights using each barrier's stored severity", () => {
    const result = openBarriersFactor.compute(
      makeParticipant({
        open_barriers: [
          { type: "Repair", severity: "high" },
          { type: "Repair", severity: "medium" },
          { type: "Other", severity: "low" },
        ],
      }),
      baseConfig,
    );
    expect(result.valueNumeric).toBe(6); // 3 + 2 + 1 from default weights
    expect(result.valueLabel).toBe("3 open (1h/1m/1l)");
  });

  it("uses configured severity weights, not hardcoded ordinals (BR-37)", () => {
    // P1E-03 — severity weights move from hardcoded ordinals to M-CONFIG.
    const config = makeConfig({
      barrierSeverityHigh: "10.00",
      barrierSeverityMedium: "5.00",
      barrierSeverityLow: "1.00",
    });
    const result = openBarriersFactor.compute(
      makeParticipant({
        open_barriers: [
          { type: "A", severity: "high" },
          { type: "B", severity: "medium" },
          { type: "C", severity: "low" },
        ],
      }),
      config,
    );
    expect(result.valueNumeric).toBe(16); // 10 + 5 + 1
  });

  it("prefers configuration classification over stored severity (BR-37)", () => {
    const config = makeConfig({
      barrierSeverityClassification: { Repair: "high", Other: "low" },
    });
    const result = openBarriersFactor.compute(
      makeParticipant({
        open_barriers: [
          { type: "Repair", severity: "low" },
          { type: "Other", severity: "high" },
        ],
      }),
      config,
    );
    // Config wins: Repair→high(3), Other→low(1), sum=4
    expect(result.valueNumeric).toBe(4);
  });

  it("falls back to stored severity when classification missing", () => {
    const config = makeConfig({
      barrierSeverityClassification: { OnlyKnown: "high" },
    });
    const result = openBarriersFactor.compute(
      makeParticipant({
        open_barriers: [{ type: "Unknown", severity: "medium" }],
      }),
      config,
    );
    expect(result.valueNumeric).toBe(2);
  });

  it("contributes 0 when both classification and stored severity are missing", () => {
    const result = openBarriersFactor.compute(
      makeParticipant({
        open_barriers: [{ type: "Mystery" }],
      }),
      baseConfig,
    );
    expect(result.valueNumeric).toBe(0);
    expect(result.valueLabel).toContain("?");
  });

  it("surfaces a dataQualityWarning when a barrier Type is unmapped (GAP-25/GAP-26)", () => {
    const result = openBarriersFactor.compute(
      makeParticipant({
        open_barriers: [{ type: "Habitability / building condition" }, { type: "Unknown" }],
      }),
      baseConfig,
    );
    expect(result.dataQualityWarning).toBe(
      "barrier_type_unmapped_check_br25_br26 (2)",
    );
  });

  it("does not emit dataQualityWarning when every barrier is classified", () => {
    const result = openBarriersFactor.compute(
      makeParticipant({
        open_barriers: [
          { type: "A", severity: "high" },
          { type: "B", severity: "low" },
        ],
      }),
      baseConfig,
    );
    expect(result.dataQualityWarning).toBeUndefined();
  });

  it("throws when open_barriers is not an array", () => {
    expect(() =>
      openBarriersFactor.compute(
        makeParticipant({ open_barriers: "high" }),
        baseConfig,
      ),
    ).toThrow(/must be array/);
  });

  // BR-39 — staleness multiplier.

  it("applies staleness multiplier when daysSinceLastUpdate ≥ threshold", () => {
    const result = openBarriersFactor.compute(
      makeParticipant({
        open_barriers: [
          { type: "A", severity: "high", daysSinceLastUpdate: 30 },
        ],
      }),
      baseConfig,
    );
    // 3.00 (high weight) × 1.50 (staleness) = 4.5
    expect(result.valueNumeric).toBeCloseTo(4.5, 5);
  });

  it("does NOT apply staleness multiplier below threshold", () => {
    const result = openBarriersFactor.compute(
      makeParticipant({
        open_barriers: [
          { type: "A", severity: "high", daysSinceLastUpdate: 29 },
        ],
      }),
      baseConfig,
    );
    expect(result.valueNumeric).toBe(3); // raw weight, no multiplier
  });

  it("does NOT apply staleness multiplier when daysSinceLastUpdate is null", () => {
    const result = openBarriersFactor.compute(
      makeParticipant({
        open_barriers: [
          { type: "A", severity: "medium", daysSinceLastUpdate: null },
        ],
      }),
      baseConfig,
    );
    expect(result.valueNumeric).toBe(2);
  });

  it("honors a custom staleness threshold and multiplier from M-CONFIG", () => {
    const config = makeConfig({
      barrierStalenessThresholdDays: 7,
      barrierStalenessMultiplier: "2.00",
    });
    const result = openBarriersFactor.compute(
      makeParticipant({
        open_barriers: [
          { type: "A", severity: "low", daysSinceLastUpdate: 7 }, // stale
          { type: "B", severity: "low", daysSinceLastUpdate: 6 }, // fresh
        ],
      }),
      config,
    );
    // 1 × 2 (stale) + 1 (fresh) = 3
    expect(result.valueNumeric).toBe(3);
  });

  // P1E-03 — per-barrier subContributions for the P0-11 calibration UI.

  it("emits per-barrier subContributions with classification + recordId", () => {
    const result = openBarriersFactor.compute(
      makeParticipant({
        open_barriers: [
          { id: "a0Bxx0000001ABC", type: "Cannot reach participant", severity: "high" },
          { id: "a0Bxx0000002DEF", type: "Bad credit", severity: "low" },
        ],
      }),
      baseConfig,
    );
    expect(result.subContributions).toEqual([
      {
        label: "Cannot reach participant",
        valueNumeric: 3,
        classification: "high",
        recordId: "a0Bxx0000001ABC",
      },
      {
        label: "Bad credit",
        valueNumeric: 1,
        classification: "low",
        recordId: "a0Bxx0000002DEF",
      },
    ]);
  });

  it("omits classification on subContribution when severity unresolved", () => {
    const result = openBarriersFactor.compute(
      makeParticipant({
        open_barriers: [{ type: "Mystery" }],
      }),
      baseConfig,
    );
    expect(result.subContributions).toEqual([
      { label: "Mystery", valueNumeric: 0 },
    ]);
  });

  it("subContribution carries the post-multiplier value (BR-39)", () => {
    const result = openBarriersFactor.compute(
      makeParticipant({
        open_barriers: [
          {
            id: "a0Bxx0000003GHI",
            type: "X",
            severity: "high",
            daysSinceLastUpdate: 45,
          },
        ],
      }),
      baseConfig,
    );
    expect(result.subContributions?.[0]).toEqual({
      label: "X",
      valueNumeric: 4.5,
      classification: "high",
      recordId: "a0Bxx0000003GHI",
    });
  });

  it("omits subContributions when no barriers contribute", () => {
    const result = openBarriersFactor.compute(
      makeParticipant({ open_barriers: [] }),
      baseConfig,
    );
    expect(result.subContributions).toBeUndefined();
  });
});
