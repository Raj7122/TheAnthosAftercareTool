// TR-PRIORITY-10 / BR-23 — asymmetric weighted calibration agreement metric.
//
// Formula:
//   score = A / (A + α·FP + β·FN)
//
// where, per FS v1.12 §BR-23:
//   A  (agreement)        = (engine Tier 1 or 2 + specialist "yes")
//                         ∪ (engine Tier 3       + specialist "no")
//   FP (false positive)   = (engine Tier 1 or 2 + specialist "no")
//   FN (false negative)   = (engine Tier 3       + specialist "yes")
//
// α and β are configuration — domain-config fields `calibrationAlpha` and
// `calibrationBeta` (camelCase domain names, not spec-canonical identifiers;
// starting values 1.0 and 2.0). They arrive here as parameters — the metric
// does not embed defaults. Both must be strictly positive: α=0 erases the
// false-positive penalty, β=0 erases the false-negative penalty (defeating
// the whole point of BR-23), and α=β=0 collapses the denominator to A — at
// which point the metric reports 1.0 for any session with even one
// agreement, silently passing the ≥85% gate. Fail loud instead.
//
// Engine `bucketTier()` already collapses "no flag" into Tier 3 as its
// fall-through bucket, so this function only models tiers {1, 2, 3}. Anything
// else is a contract violation upstream and fails loud.
//
// Pure: no I/O, no mutation, deterministic — same input → same output.
// Threshold enforcement (≥85%, BR-20/BR-23) and the calibration-participants
// floor live in the caller (P0-13b).

export type SpecialistJudgment = "yes" | "no";

export interface CalibrationItem {
  readonly engineTier: number;
  readonly specialistJudgment: SpecialistJudgment;
}

export interface WeightedAgreementResult {
  readonly score: number;
  readonly agreements: number;
  readonly falsePositives: number;
  readonly falseNegatives: number;
}

export function computeWeightedAgreement(
  items: ReadonlyArray<CalibrationItem>,
  alpha: number,
  beta: number,
): WeightedAgreementResult {
  if (items.length === 0) {
    throw new Error("computeWeightedAgreement requires at least one item");
  }
  assertPositiveFinite("alpha", alpha);
  assertPositiveFinite("beta", beta);

  let agreements = 0;
  let falsePositives = 0;
  let falseNegatives = 0;

  for (let i = 0; i < items.length; i++) {
    const { engineTier, specialistJudgment } = items[i]!;
    switch (classify(engineTier, specialistJudgment, i)) {
      case "A":
        agreements++;
        break;
      case "FP":
        falsePositives++;
        break;
      case "FN":
        falseNegatives++;
        break;
    }
  }

  const denominator = agreements + alpha * falsePositives + beta * falseNegatives;
  // Denominator is strictly positive: items.length > 0 puts at least one
  // count into A/FP/FN, and the assertPositiveFinite guards on α and β
  // prevent the FP/FN legs from collapsing to zero. Score is always finite.
  const score = agreements / denominator;

  return { score, agreements, falsePositives, falseNegatives };
}

type Outcome = "A" | "FP" | "FN";

function classify(
  engineTier: number,
  specialistJudgment: SpecialistJudgment,
  index: number,
): Outcome {
  if (engineTier !== 1 && engineTier !== 2 && engineTier !== 3) {
    throw new Error(
      `computeWeightedAgreement: items[${index}].engineTier must be 1, 2, or 3 (received ${engineTier})`,
    );
  }
  if (specialistJudgment !== "yes" && specialistJudgment !== "no") {
    throw new Error(
      `computeWeightedAgreement: items[${index}].specialistJudgment must be "yes" or "no" (received ${JSON.stringify(specialistJudgment)})`,
    );
  }

  const flagged = engineTier === 1 || engineTier === 2;
  const specialistYes = specialistJudgment === "yes";

  if (flagged && specialistYes) return "A";
  if (!flagged && !specialistYes) return "A";
  if (flagged && !specialistYes) return "FP";
  return "FN";
}

function assertPositiveFinite(name: string, value: number): void {
  if (!Number.isFinite(value)) {
    throw new Error(
      `computeWeightedAgreement: ${name} must be a finite number (received ${value})`,
    );
  }
  if (value <= 0) {
    throw new Error(
      `computeWeightedAgreement: ${name} must be > 0 (received ${value})`,
    );
  }
}
