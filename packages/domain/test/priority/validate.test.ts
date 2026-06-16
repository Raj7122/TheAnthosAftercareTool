import { describe, expect, it } from "vitest";

import {
  ConfigValidationError,
  FactorTypeError,
  computePriority,
} from "../../src/priority/index.js";
import { makeConfig, makeFactor, makeParticipant } from "./_fixtures.js";

// TR-PRIORITY-3 (VR-05 / VR-06 / VR-07): engine refuses to start on bad
// config; failures are loud, named, and carry enough detail to debug.

describe("computePriority — VR-05 fail-loud missing weight", () => {
  it("throws ConfigValidationError naming the offending factor key", () => {
    expect(() =>
      computePriority({
        participant: makeParticipant(),
        configuration: makeConfig(),
        factors: [
          makeFactor({ key: "days_since_last_contact", valueNumeric: 16 }),
          makeFactor({ key: "factor_not_in_config", valueNumeric: 1 }),
        ],
      }),
    ).toThrowError(ConfigValidationError);
  });

  it("error code is VR_05_MISSING_WEIGHT and message names the key", () => {
    try {
      computePriority({
        participant: makeParticipant(),
        configuration: makeConfig(),
        factors: [makeFactor({ key: "factor_not_in_config", valueNumeric: 1 })],
      });
      expect.fail("expected ConfigValidationError");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigValidationError);
      const e = err as ConfigValidationError;
      expect(e.code).toBe("VR_05_MISSING_WEIGHT");
      expect(e.message).toContain("factor_not_in_config");
    }
  });
});

describe("computePriority — VR-05 fail-loud invalid weight", () => {
  // Production callers go through configurationSchema (Zod) which rejects
  // non-finite values at load time. These tests construct a Configuration
  // directly to exercise the engine-layer defence-in-depth guard.
  it("rejects NaN weight with code VR_05_INVALID_WEIGHT", () => {
    const badConfig = makeConfig({
      factorWeights: {
        additive: { days_since_last_contact: Number.NaN },
        multiplicative_modifiers: {},
        overlap_caps: [],
      },
    });
    try {
      computePriority({
        participant: makeParticipant(),
        configuration: badConfig,
        factors: [
          makeFactor({ key: "days_since_last_contact", valueNumeric: 1 }),
        ],
      });
      expect.fail("expected ConfigValidationError");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigValidationError);
      const e = err as ConfigValidationError;
      expect(e.code).toBe("VR_05_INVALID_WEIGHT");
      expect(e.message).toContain("days_since_last_contact");
    }
  });

  it("rejects Infinity weight with code VR_05_INVALID_WEIGHT", () => {
    const badConfig = makeConfig({
      factorWeights: {
        additive: { failed_attempts: Number.POSITIVE_INFINITY },
        multiplicative_modifiers: {},
        overlap_caps: [],
      },
    });
    try {
      computePriority({
        participant: makeParticipant(),
        configuration: badConfig,
        factors: [makeFactor({ key: "failed_attempts", valueNumeric: 1 })],
      });
      expect.fail("expected ConfigValidationError");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigValidationError);
      const e = err as ConfigValidationError;
      expect(e.code).toBe("VR_05_INVALID_WEIGHT");
      expect(e.message).toContain("failed_attempts");
    }
  });
});

describe("computePriority — VR-06 tier thresholds ordered", () => {
  it("throws when tier2_min >= tier1_min", () => {
    const badConfig = makeConfig({
      tierThresholds: { tier1_min: 50, tier2_min: 80 }, // inverted
    });
    expect(() =>
      computePriority({
        participant: makeParticipant(),
        configuration: badConfig,
        factors: [
          makeFactor({ key: "days_since_last_contact", valueNumeric: 1 }),
        ],
      }),
    ).toThrowError(ConfigValidationError);
  });

  it("throws when tier2_min === tier1_min", () => {
    const badConfig = makeConfig({
      tierThresholds: { tier1_min: 50, tier2_min: 50 },
    });
    try {
      computePriority({
        participant: makeParticipant(),
        configuration: badConfig,
        factors: [
          makeFactor({ key: "days_since_last_contact", valueNumeric: 1 }),
        ],
      });
      expect.fail("expected ConfigValidationError");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigValidationError);
      const e = err as ConfigValidationError;
      expect(e.code).toBe("VR_06_THRESHOLDS_UNORDERED");
    }
  });
});

describe("computePriority — VR-07 factor type + value", () => {
  it("throws FactorTypeError when a factor returns non-finite valueNumeric", () => {
    const badFactor = {
      key: "days_since_last_contact",
      displayName: "Days",
      type: "numeric" as const,
      compute() {
        return { valueLabel: "Infinity", valueNumeric: Number.POSITIVE_INFINITY };
      },
    };
    try {
      computePriority({
        participant: makeParticipant(),
        configuration: makeConfig(),
        factors: [badFactor],
      });
      expect.fail("expected FactorTypeError");
    } catch (err) {
      expect(err).toBeInstanceOf(FactorTypeError);
      const e = err as FactorTypeError;
      expect(e.code).toBe("VR_07_NON_FINITE_VALUE");
      expect(e.factorKey).toBe("days_since_last_contact");
    }
  });

  it("throws FactorTypeError when a factor declares an unknown type", () => {
    // Construct a deliberately invalid Factor (type outside the FactorType
    // enum) and cast through `unknown` — TypeScript can't help in production
    // if a future Factor is built dynamically, so VR-07 is the runtime guard.
    const badFactor = {
      key: "days_since_last_contact",
      displayName: "Days",
      type: "freeform_string",
      compute() {
        return { valueLabel: "16", valueNumeric: 16 };
      },
    } as unknown as import("../../src/priority/index.js").Factor;

    try {
      computePriority({
        participant: makeParticipant(),
        configuration: makeConfig(),
        factors: [badFactor],
      });
      expect.fail("expected FactorTypeError");
    } catch (err) {
      expect(err).toBeInstanceOf(FactorTypeError);
      const e = err as FactorTypeError;
      expect(e.code).toBe("VR_07_UNKNOWN_TYPE");
    }
  });
});
