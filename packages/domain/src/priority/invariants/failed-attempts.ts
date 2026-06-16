import type {
  FactorContribution,
  HydratedParticipant,
  TierInvariant,
  TierInvariantCheckResult,
} from "../types.js";

// BR-24 / TR-PRIORITY-15 — categorical Tier 1 floor when failed contact
// attempts in the current cycle (Status='Attempted' after the BR-19c reset
// rule) are ≥ `failed_attempts_tier1_threshold`. Floor-not-cap: the
// participant may score higher via factor math but cannot score lower.
//
// The invariant reads `failed_attempts` off the per-factor contribution row
// rather than the raw participant, so the Tier 1 floor fires off the exact
// same number the UI displays — preserves BR-12 transparency for invariants
// per TR-PRIORITY-15.
export const BR_24_INVARIANT_ID = "BR-24";
export const BR_24_FACTOR_KEY = "failed_attempts";

export interface FailedAttemptsInvariantOptions {
  readonly threshold: number;
  readonly displayLabel?: string;
  readonly floorTier?: number;
}

export function createFailedAttemptsInvariant(
  options: FailedAttemptsInvariantOptions,
): TierInvariant {
  const threshold = options.threshold;
  const displayLabel =
    options.displayLabel ?? "Failed contact attempts ≥ threshold";
  const floorTier = options.floorTier ?? 1;

  return {
    id: BR_24_INVARIANT_ID,
    check(
      _participant: HydratedParticipant,
      contributions: ReadonlyArray<FactorContribution>,
    ): TierInvariantCheckResult {
      const row = contributions.find((c) => c.key === BR_24_FACTOR_KEY);
      const attempts = row?.valueNumeric ?? 0;
      const triggered =
        Number.isFinite(attempts) && attempts >= threshold;
      return {
        triggered,
        label: displayLabel,
        floorTier,
      };
    },
  };
}
