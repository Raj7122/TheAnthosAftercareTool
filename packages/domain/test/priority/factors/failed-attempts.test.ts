import { describe, expect, it } from "vitest";

import { failedAttemptsFactor } from "../../../src/priority/factors/failed-attempts.js";
import { makeConfig, makeParticipant } from "../_fixtures.js";

const config = makeConfig(); // failed_attempts_tier1_threshold: 999 (no saturation)

describe("BR-19(c) — failed_attempts factor", () => {
  it("maps 0 to '0 attempts'", () => {
    const result = failedAttemptsFactor.compute(
      makeParticipant({ failed_attempts: 0 }),
      config,
    );
    expect(result).toEqual({ valueLabel: "0 attempts", valueNumeric: 0 });
  });

  it("uses singular 'attempt' for 1", () => {
    const result = failedAttemptsFactor.compute(
      makeParticipant({ failed_attempts: 1 }),
      config,
    );
    expect(result).toEqual({ valueLabel: "1 attempt", valueNumeric: 1 });
  });

  it("passes positive counts below the threshold through", () => {
    const result = failedAttemptsFactor.compute(
      makeParticipant({ failed_attempts: 3 }),
      config,
    );
    expect(result.valueNumeric).toBe(3);
    expect(result.valueLabel).toBe("3 attempts");
  });

  it("clamps negative to 0", () => {
    const result = failedAttemptsFactor.compute(
      makeParticipant({ failed_attempts: -2 }),
      config,
    );
    expect(result.valueNumeric).toBe(0);
  });

  it("throws on non-numeric", () => {
    expect(() =>
      failedAttemptsFactor.compute(
        makeParticipant({ failed_attempts: "two" }),
        config,
      ),
    ).toThrow(/must be number/);
  });

  // Saturation at the BR-24 threshold (the escalation boundary). Past the
  // threshold the categorical invariant has already fired; the soft score
  // flattens rather than rewarding 8 attempts over 7.
  describe("saturates at the BR-24 threshold", () => {
    const br24 = makeConfig({
      tierInvariants: {
        failed_attempts_tier1_threshold: 3,
        barrier_type_to_invariant: {},
        open_repair_invariant: null,
        invariant_override_suppression: true,
      },
    });

    it("caps the value at the threshold with an honest label", () => {
      const result = failedAttemptsFactor.compute(
        makeParticipant({ failed_attempts: 5 }),
        br24,
      );
      expect(result.valueNumeric).toBe(3);
      expect(result.valueLabel).toBe("5 attempts (capped at 3)");
    });

    it("passes the threshold boundary through unflagged", () => {
      const result = failedAttemptsFactor.compute(
        makeParticipant({ failed_attempts: 3 }),
        br24,
      );
      expect(result).toEqual({ valueLabel: "3 attempts", valueNumeric: 3 });
    });

    it("leaves a sub-threshold count untouched", () => {
      const result = failedAttemptsFactor.compute(
        makeParticipant({ failed_attempts: 2 }),
        br24,
      );
      expect(result.valueNumeric).toBe(2);
    });

    // Invariant-safety: a saturated value still satisfies the BR-24 `>=` test,
    // so capping never suppresses a Tier-1 floor that would otherwise fire.
    it("keeps the saturated value >= threshold (BR-24 still fires)", () => {
      const result = failedAttemptsFactor.compute(
        makeParticipant({ failed_attempts: 8 }),
        br24,
      );
      expect(result.valueNumeric).toBeGreaterThanOrEqual(3);
    });
  });
});
