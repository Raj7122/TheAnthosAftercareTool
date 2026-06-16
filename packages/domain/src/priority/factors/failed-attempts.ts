import type { Configuration } from "../../config/index.js";
import type {
  Factor,
  FactorComputeResult,
  HydratedParticipant,
} from "../types.js";

// BR-19(c) — Failed contact attempts in current cycle.
// Source: Case Notes with Status = 'Attempted'. Counter resets to 0 on any
// successful contact (Completed, or Seen by Other Provider per Path B).
// 'Scheduled' / 'Rescheduled' / 'Canceled' Case Notes do NOT count.
//
// Engine input: HydratedParticipant.failed_attempts is a non-negative number.
// Negative values clamp to 0 (defensive — hydration shouldn't produce them).
//
// The soft contribution saturates at the BR-24 threshold
// (`configuration.tierInvariants.failed_attempts_tier1_threshold`): the signal
// is "not responding", not 8 attempts vs 7. Past the threshold the categorical
// BR-24 invariant has already fired and floored the case to Tier 1, so the
// weighted score should flatten there rather than keep climbing. We reuse the
// invariant's own threshold so there is a single tunable source of truth.
// Capping at exactly the threshold is invariant-safe: BR-24 fires on
// valueNumeric ≥ threshold, and a capped value of `threshold` still satisfies
// `≥` for every at/above-threshold case (the invariant reads this same
// valueNumeric per BR-12), so flooring behavior is unchanged.

export const failedAttemptsFactor: Factor = {
  key: "failed_attempts",
  displayName: "Failed contact attempts",
  type: "numeric",
  compute(
    participant: HydratedParticipant,
    configuration: Configuration,
  ): FactorComputeResult {
    const raw = participant["failed_attempts"];
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      throw new Error(`failed_attempts must be number, got ${typeof raw}`);
    }
    const clamped = raw < 0 ? 0 : raw;
    const threshold =
      configuration.tierInvariants.failed_attempts_tier1_threshold;
    const saturated = clamped > threshold ? threshold : clamped;
    const count = clamped === 1 ? "1 attempt" : `${clamped} attempts`;
    const label =
      saturated < clamped ? `${count} (capped at ${threshold})` : count;
    return { valueLabel: label, valueNumeric: saturated };
  },
};
