// FeatureFlagClient — the vendor-agnostic surface every feature consumes.
// isEnabled / getVariant are the entire public API (P1A-05 keeps the seam
// minimal: no bulk-evaluate, no caching until a real consumer needs them).
//
// Fail-closed posture lives here, so every provider inherits it: an unknown
// flag key, a provider that throws, or a malformed backend rule all resolve
// to OFF with a structured warning — these methods never throw.
import { logEvaluationError, logUnknownFlag } from "./log.js";
import { selectFeatureFlagProvider } from "./provider-selector.js";
import type {
  FeatureFlagProvider,
  FlagEvaluation,
  SpecialistContext,
} from "./types.js";

export class FeatureFlagClient {
  constructor(private readonly provider: FeatureFlagProvider) {}

  // True only when the flag resolves on for this specialist. Default is OFF —
  // an unknown key, a provider error, or a malformed rule all return false.
  async isEnabled(
    flagKey: string,
    context: SpecialistContext,
  ): Promise<boolean> {
    const evaluation = await this.evaluateSafely(flagKey, context);
    return evaluation?.enabled ?? false;
  }

  // The variant name when the flag is on and carries one; null otherwise
  // (off, unknown, errored, or on without a named variant).
  async getVariant(
    flagKey: string,
    context: SpecialistContext,
  ): Promise<string | null> {
    const evaluation = await this.evaluateSafely(flagKey, context);
    if (evaluation === null || !evaluation.enabled) {
      return null;
    }
    return evaluation.variant;
  }

  // Runs the provider and converts every failure mode into the default (OFF):
  // an unknown key -> null + warning; a thrown provider -> null + error log.
  private async evaluateSafely(
    flagKey: string,
    context: SpecialistContext,
  ): Promise<FlagEvaluation | null> {
    try {
      const evaluation = await this.provider.evaluate(flagKey, context);
      if (evaluation === null) {
        logUnknownFlag(flagKey, context.role);
        return null;
      }
      return evaluation;
    } catch (err) {
      logEvaluationError(flagKey, context.role, err);
      return null;
    }
  }
}

// Construct a client. With no argument the provider is chosen from the
// environment (Edge Config when EDGE_CONFIG is set, else the local provider).
// Tests pass an explicit provider.
export function createFeatureFlagClient(
  provider?: FeatureFlagProvider,
): FeatureFlagClient {
  return new FeatureFlagClient(provider ?? selectFeatureFlagProvider());
}
