import type { Configuration } from "../config/index.js";
import { ConfigValidationError, FactorTypeError } from "./errors.js";
import { parseTierEntries } from "./tier.js";
import type { Factor, FactorComputeResult, FactorType } from "./types.js";

// VR-05 / VR-06 / VR-07 fail-loud checks per TR-PRIORITY-3.
// These run at engine entry; throw before any factor computation.

export function assertConfigValid(
  configuration: Configuration,
  factors: ReadonlyArray<Factor>,
): void {
  assertEveryFactorHasWeight(configuration, factors);     // VR-05
  assertTierThresholdsOrdered(configuration);             // VR-06
  assertFactorTypesKnown(factors);                        // VR-07 (declaration side)
}

// VR-05 — every supplied factor key must exist in factor_weights.additive
// AND its declared weight must be a finite number. Engine refuses to start
// (TRD §TR-PRIORITY-3). The invalid-weight branch is defence-in-depth
// against a Configuration constructed without going through the Zod
// schema (which already rejects non-finite values).
function assertEveryFactorHasWeight(
  configuration: Configuration,
  factors: ReadonlyArray<Factor>,
): void {
  const additive = configuration.factorWeights.additive;
  const missing: string[] = [];
  const invalid: Array<{ key: string; value: number }> = [];

  for (const factor of factors) {
    const weight = additive[factor.key];
    if (weight === undefined) {
      missing.push(factor.key);
    } else if (!Number.isFinite(weight)) {
      invalid.push({ key: factor.key, value: weight });
    }
  }

  if (missing.length > 0) {
    throw new ConfigValidationError(
      "VR_05_MISSING_WEIGHT",
      `Factor weight missing for: ${missing.join(", ")}`,
      { missingKeys: missing, configurationVersion: configuration.version },
    );
  }

  if (invalid.length > 0) {
    const first = invalid[0];
    if (first === undefined) return;
    throw new ConfigValidationError(
      "VR_05_INVALID_WEIGHT",
      `Factor weight for '${first.key}' is not finite: ${String(first.value)}`,
      {
        invalid,
        configurationVersion: configuration.version,
      },
    );
  }
}

// VR-06 — tier minimums must be strictly descending by tier number.
// (Tier 1 is highest priority and has the highest score floor.)
function assertTierThresholdsOrdered(configuration: Configuration): void {
  const entries = parseTierEntries(configuration.tierThresholds);
  for (let i = 1; i < entries.length; i++) {
    const prev = entries[i - 1];
    const curr = entries[i];
    if (prev === undefined || curr === undefined) continue;
    if (curr.min >= prev.min) {
      throw new ConfigValidationError(
        "VR_06_THRESHOLDS_UNORDERED",
        `tier${curr.tier}_min (${curr.min}) must be strictly less than tier${prev.tier}_min (${prev.min})`,
        {
          configurationVersion: configuration.version,
          unorderedAt: { tier: curr.tier, min: curr.min },
          priorTier: { tier: prev.tier, min: prev.min },
        },
      );
    }
  }
}

// VR-07 (declaration side) — factor `type` must be a known enum value.
// The value side (finite numeric) is enforced inside compute() per call.
const KNOWN_FACTOR_TYPES: ReadonlySet<FactorType> = new Set<FactorType>([
  "numeric",
  "categorical",
]);

function assertFactorTypesKnown(factors: ReadonlyArray<Factor>): void {
  for (const factor of factors) {
    if (!KNOWN_FACTOR_TYPES.has(factor.type)) {
      throw new FactorTypeError(
        "VR_07_UNKNOWN_TYPE",
        factor.key,
        `Factor '${factor.key}' has unknown type '${factor.type as string}'`,
      );
    }
  }
}

// VR-07 (value side) — each factor.compute() result must be finite.
// Called from compute.ts after invoking factor.compute().
export function assertFactorResultFinite(
  factorKey: string,
  result: FactorComputeResult,
): void {
  if (!Number.isFinite(result.valueNumeric)) {
    throw new FactorTypeError(
      "VR_07_NON_FINITE_VALUE",
      factorKey,
      `Factor '${factorKey}' returned non-finite valueNumeric: ${String(result.valueNumeric)}`,
    );
  }
}
