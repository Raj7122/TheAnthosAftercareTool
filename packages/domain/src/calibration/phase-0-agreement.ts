// P0-13b — engine-vs-label weighted-agreement compute for Phase 0
// calibration (TR-PRIORITY-10, BR-23, AC-09; impl plan v1.4 §3 row P0-13b).
//
// Joins the labeled dataset (P0-13a profiles + per-specialist LabelSets)
// to the priority engine's tier output and feeds the result into the
// asymmetric BR-23 weighted-agreement metric (P0-07).
//
// Aggregate semantics: POOLED. All specialists' labels are concatenated
// into a single CalibrationItem[] and `computeWeightedAgreement` is called
// once on the union. This matches BR-23's count-based form (A, FP, FN are
// counts of independent (profile, specialist) observations); per-specialist
// scores are still reported for downstream FN/FP analysis (P0-14, P0-14a)
// but the gate (≥85%, Immutable #2) is asserted against the pooled number.
//
// Pure: no I/O, no Date.now(). The test wrapper handles file reads and
// injects `now` so generated_at is deterministic in CI.

import type { Configuration } from "../config/index.js";
import { computePriority } from "../priority/compute.js";
import type {
  Factor,
  HydratedParticipant,
} from "../priority/types.js";

import {
  computeWeightedAgreement,
  type CalibrationItem,
  type SpecialistJudgment,
  type WeightedAgreementResult,
} from "./metric.js";
import type {
  Phase0LabelSet,
  Phase0Profile,
} from "./phase-0-types.js";

export interface Phase0PerItem {
  readonly profile_id: string;
  readonly specialist_id: string;
  readonly engineTier: number;
  readonly specialistJudgment: SpecialistJudgment;
  readonly classification: "A" | "FP" | "FN";
}

export interface Phase0SpecialistAgreement {
  readonly specialist_id: string;
  readonly session_date: string;
  readonly itemCount: number;
  readonly score: number;
  readonly agreements: number;
  readonly falsePositives: number;
  readonly falseNegatives: number;
  readonly per_item: ReadonlyArray<Phase0PerItem>;
}

export interface Phase0AggregateAgreement extends WeightedAgreementResult {
  readonly itemCount: number;
}

export interface Phase0AgreementReport {
  readonly schema_version: 1;
  readonly generated_at: string;
  readonly configuration_version: number;
  readonly alpha: number;
  readonly beta: number;
  readonly perSpecialist: ReadonlyArray<Phase0SpecialistAgreement>;
  readonly aggregate: Phase0AggregateAgreement;
}

export interface ComputePhase0AgreementInput {
  readonly profiles: ReadonlyArray<Phase0Profile>;
  readonly labelSets: ReadonlyArray<Phase0LabelSet>;
  readonly factors: ReadonlyArray<Factor>;
  readonly configuration: Configuration;
  readonly alpha: number;
  readonly beta: number;
  readonly now: Date;
}

// profileToHydratedParticipant — adapts a P0-13a synthetic profile to the
// engine's HydratedParticipant shape. The 9 BR-19 factor fields land as
// top-level properties (HydratedParticipant is
// { participantId, hydratedAt, [factorKey: string]: unknown } — see
// packages/domain/src/priority/types.ts), so each P0-04 Factor's compute()
// can read its field directly with no further adaptation. The profile's
// `profile_id` is used as the engine's `participantId`.
export function profileToHydratedParticipant(
  profile: Phase0Profile,
  hydratedAt: Date,
): HydratedParticipant {
  return {
    participantId: profile.profile_id,
    hydratedAt,
    ...profile.factors,
  };
}

export function computePhase0Agreement(
  input: ComputePhase0AgreementInput,
): Phase0AgreementReport {
  if (input.labelSets.length === 0) {
    throw new Error(
      "computePhase0Agreement requires at least one LabelSet (P0-13a)",
    );
  }
  if (input.factors.length === 0) {
    throw new Error(
      "computePhase0Agreement requires at least one Factor — wire P0-04 (factor registry returns []) before invoking the gate measurement",
    );
  }

  const profileById = new Map<string, Phase0Profile>();
  for (const profile of input.profiles) {
    profileById.set(profile.profile_id, profile);
  }

  // Memoize engine output per profile — every label for the same profile
  // sees the same tier regardless of which specialist labeled it.
  const tierByProfile = new Map<string, number>();
  for (const profile of input.profiles) {
    const participant = profileToHydratedParticipant(profile, input.now);
    const output = computePriority({
      participant,
      configuration: input.configuration,
      factors: input.factors,
    });
    tierByProfile.set(profile.profile_id, output.tier);
  }

  const perSpecialist: Phase0SpecialistAgreement[] = [];
  const pooledItems: CalibrationItem[] = [];

  for (const labelSet of input.labelSets) {
    const items: CalibrationItem[] = [];
    const perItem: Phase0PerItem[] = [];

    for (const label of labelSet.labels) {
      const tier = tierByProfile.get(label.profile_id);
      if (tier === undefined) {
        throw new Error(
          `computePhase0Agreement: label for specialist '${labelSet.specialist_id}' references profile_id '${label.profile_id}' that does not exist in the profile set`,
        );
      }
      const item: CalibrationItem = {
        engineTier: tier,
        specialistJudgment: label.judgment,
      };
      items.push(item);
      pooledItems.push(item);
      perItem.push({
        profile_id: label.profile_id,
        specialist_id: label.specialist_id,
        engineTier: tier,
        specialistJudgment: label.judgment,
        classification: classifyAgreementOutcome(tier, label.judgment),
      });
    }

    const result = computeWeightedAgreement(items, input.alpha, input.beta);
    perSpecialist.push({
      specialist_id: labelSet.specialist_id,
      session_date: labelSet.session_date,
      itemCount: items.length,
      score: result.score,
      agreements: result.agreements,
      falsePositives: result.falsePositives,
      falseNegatives: result.falseNegatives,
      per_item: perItem,
    });
  }

  const aggregateRaw = computeWeightedAgreement(
    pooledItems,
    input.alpha,
    input.beta,
  );

  return {
    schema_version: 1,
    generated_at: input.now.toISOString(),
    configuration_version: input.configuration.version,
    alpha: input.alpha,
    beta: input.beta,
    perSpecialist,
    aggregate: {
      ...aggregateRaw,
      itemCount: pooledItems.length,
    },
  };
}

// Exported mirror of metric.ts's private `classify` so `per_item` can carry
// the outcome without exposing internals from `metric.ts`. Alignment with
// `computeWeightedAgreement`'s classification table is enforced
// mechanically by the parametric `it.each` test in
// test/calibration/phase-0-agreement.test.ts — any drift on either side
// fails that test loudly. `metric.ts` remains the source of truth for the
// BR-23 contract; this function exists so calibration consumers can label
// individual items without round-tripping through the count-only metric.
export function classifyAgreementOutcome(
  engineTier: number,
  specialistJudgment: SpecialistJudgment,
): "A" | "FP" | "FN" {
  const flagged = engineTier === 1 || engineTier === 2;
  const specialistYes = specialistJudgment === "yes";
  if (flagged && specialistYes) return "A";
  if (!flagged && !specialistYes) return "A";
  if (flagged && !specialistYes) return "FP";
  return "FN";
}
