import { applyTierFloors } from "./apply-tier-floors.js";
import { formatWeight } from "./format.js";
import { applyOverlapCaps } from "./overlap-caps.js";
import type { TriggeredOverlapCap } from "./overlap-caps.js";
import { decideSuppressionOverride } from "./suppression-override.js";
import { bucketTier, tierLabelFor } from "./tier.js";
import type {
  EngineInput,
  EngineOutput,
  FactorContribution,
  HighestImpactFactor,
} from "./types.js";
import { assertConfigValid, assertFactorResultFinite } from "./validate.js";

// PriorityEngine core (TR-PRIORITY-1..7).
//
// Pure function: same EngineInput → same EngineOutput, no I/O, no side effects.
// Idempotent per BR-17. Recompute triggers (TR-PRIORITY-5) and per-participant
// isolation (TR-PRIORITY-6, BR-18) are caller concerns; the engine receives
// one participant at a time.
//
// Extension points:
//   - P0-04 supplies the nine BR-19 factors via input.factors.
//   - P0-04a wires invariant floors via input.invariants and populates
//     EngineOutput.triggeredInvariants[] — the invariant arm of the
//     TR-PRIORITY-7 v1.2 per-factor breakdown payload (TRD §1787).
//   - P0-05 applies BR-22 overlap caps at score aggregation (applyOverlapCaps).
//   - P0-05a feeds cap-aware effective contributions into pickHighestImpact so
//     the Primary Factor label (BR-12, BR-34, F-02) reflects what actually
//     moved the score rather than the strongest raw signal absorbed by a cap.
export function computePriority(input: EngineInput): EngineOutput {
  assertConfigValid(input.configuration, input.factors);

  const contributions: FactorContribution[] = input.factors.map((factor) => {
    const result = factor.compute(input.participant, input.configuration);
    assertFactorResultFinite(factor.key, result);

    // VR-05 already proved every factor.key is in additive; the lookup is
    // safe but `noUncheckedIndexedAccess` still types it as `number | undefined`.
    const weightRaw = input.configuration.factorWeights.additive[factor.key];
    if (weightRaw === undefined) {
      // Unreachable in practice — assertConfigValid threw above. The narrow
      // keeps TypeScript honest without a non-null assertion.
      throw new Error(
        `internal: weight for '${factor.key}' missing after validation`,
      );
    }

    return {
      name: factor.displayName,
      key: factor.key,
      valueLabel: result.valueLabel,
      valueNumeric: result.valueNumeric,
      weight: formatWeight(weightRaw),
      weightRaw,
      pointsContributed: result.valueNumeric * weightRaw,
      // Conditional spread keeps the optional shape clean — absent
      // (not `undefined`) when the factor didn't flag a data-quality issue.
      ...(result.dataQualityWarning !== undefined && {
        dataQualityWarning: result.dataQualityWarning,
      }),
      ...(result.subContributions !== undefined && {
        subContributions: result.subContributions,
      }),
    };
  });

  // BR-22 / TR-PRIORITY-9 — apply overlap caps at aggregation. The cap
  // collapses listed factors to MAX(pointsContributed) instead of SUM.
  // FactorContribution rows are preserved as raw values (BR-12 transparency);
  // the per-cap reasoning lands in `triggeredCaps`.
  const { effectiveScore: priorityScore, triggeredCaps } = applyOverlapCaps(
    contributions,
    input.configuration.factorWeights.overlap_caps,
  );

  const tier = bucketTier(priorityScore, input.configuration.tierThresholds);
  const highestImpactFactor = pickHighestImpact(
    buildEffectiveContributions(contributions, triggeredCaps),
  );

  // P0-04 BR-19(h) — when Aftercare Extended is active, surface a display
  // modifier per API v1.3 §7.3.1. The modifier is a label only; the score
  // contribution itself is the additive row above. If multiplicative score
  // math is later required, that lands in a separate ticket touching the
  // overlap-caps / aggregation pass.
  const priorityModifier = formatAftercareModifier(contributions);

  // TR-PRIORITY-15/16/17 — apply categorical Tier 1 invariant floors after
  // factor math. Spec rule (TRD v1.8 §1786): final tier =
  // MAX(factor_tier, invariant_tier_floor); in this codebase Tier 1 is
  // numerically lowest, so see `apply-tier-floors.ts` for the Math.min
  // inversion. `input.invariants` is optional — calibration-side callers
  // that have no enum cache yet may pass an empty list.
  const { tier: flooredTier, triggeredInvariants } = applyTierFloors(
    tier,
    input.invariants ?? [],
    input.participant,
    contributions,
  );

  // P0-04b / TR-PRIORITY-18 — when an invariant fires for a participant in
  // BR-21 Path C "Snoozed" state AND the configured override direction is
  // the default (`invariant_override_suppression: true`), emit a structured
  // override payload. Downstream BFF marshals this into the System Note
  // Case Note write (deferred — Case Note write adapter not yet built).
  // Tier flooring above is unaffected: the invariant's tier floor lands
  // regardless of the suppression-direction config; only the
  // suppression-clearing Case Note branch is gated.
  const suppressionOverride = decideSuppressionOverride({
    triggeredInvariants,
    suppression: input.suppression,
    invariantOverrideSuppression:
      input.configuration.tierInvariants.invariant_override_suppression,
  });

  return {
    participantId: input.participant.participantId,
    configurationVersion: input.configuration.version,
    priorityScore,
    tier: flooredTier,
    tierLabel: tierLabelFor(flooredTier),
    priorityModifier,
    highestImpactFactor,
    factors: contributions,
    triggeredInvariants,
    triggeredCaps,
    suppressionOverride,
  };
}

function formatAftercareModifier(
  contributions: ReadonlyArray<FactorContribution>,
): string | null {
  const row = contributions.find((c) => c.key === "aftercare_extended");
  if (row === undefined || row.valueNumeric <= 0) return null;
  // Use the same one-decimal convention as formatWeight so integer-valued
  // weights render as e.g. "×1.0" rather than "×1" — keeps the modifier
  // label visually aligned with breakdown rows (API v1.3 §7.3.1).
  return `Aftercare Extended (×${row.weightRaw.toFixed(1)})`;
}

// Highest-impact = max pointsContributed. Deterministic tie-break by `key`
// ascending so identical inputs always select the same factor. Participant-
// level tie-breaking is a separate concern (P0-06).
//
// P0-05a: callers feed the cap-aware effective contributions
// (buildEffectiveContributions below), so `pointsContributed` here is the
// post-cap effective value when a BR-22 cap fires. The function body is
// otherwise unchanged from P0-03 — same max + lex tie-break.
function pickHighestImpact(
  contributions: ReadonlyArray<FactorContribution>,
): HighestImpactFactor {
  if (contributions.length === 0) {
    // Engine should never run with zero factors in production, but the type
    // system can't prove it. Surface an empty-input error explicitly rather
    // than constructing a fake "highest factor".
    throw new Error(
      "computePriority requires at least one factor in input.factors",
    );
  }

  let winner = contributions[0];
  if (winner === undefined) {
    throw new Error("internal: contributions[0] undefined after length check");
  }
  for (let i = 1; i < contributions.length; i++) {
    const candidate = contributions[i];
    if (candidate === undefined) continue;
    if (
      candidate.pointsContributed > winner.pointsContributed ||
      (candidate.pointsContributed === winner.pointsContributed &&
        candidate.key < winner.key)
    ) {
      winner = candidate;
    }
  }

  return {
    name: winner.name,
    key: winner.key,
    valueLabel: winner.valueLabel,
    weight: winner.weight,
    pointsContributed: winner.pointsContributed,
  };
}

// P0-05a — cap-aware effective contributions for highest-impact selection.
//
// When a BR-22 overlap cap fires, the score gains MAX(pointsContributed)
// from the cap-channel rather than SUM, so a factor whose raw points were
// absorbed should not be labelled the "Primary Factor" over an uncapped
// factor that actually moved the score. The marginal-over-cap rule
// (decision captured pre-implementation; Marie to ratify at P0-13b):
//
//   - cap winner       → winningPoints − absorbedPoints  (post-cap marginal)
//   - other cap members → 0                              (fully absorbed)
//   - factors in no triggered cap → raw pointsContributed (unchanged)
//
// `EngineOutput.factors[]` rows are NOT rewritten — BR-12 transparency
// keeps them at raw values. Only the input to `pickHighestImpact` is
// transformed, so the field on `HighestImpactFactor.pointsContributed`
// carries the effective number used to make the selection.
//
// Uses only `TriggeredOverlapCap` fields — no cap-math re-derivation.
// Multi-cap participation (same factor in two cap entries) is undefined
// per spec (overlap-caps.ts §25–27); the "last cap wins" behavior of the
// Map writes here mirrors that precedent and is acceptable for Phase 0,
// which configures a single cap entry.
//
// 3+ member cap edge case: for a cap with members A=50, B=30, C=20,
// `absorbedPoints = 50` and the winner's effective collapses to 0. That is
// algebraically correct — the score gain from the cap channel (MAX=50)
// equals what the runner-up + tail would already deliver (30+20=50), so
// the winner's marginal value is zero — but it makes uncapped factors
// dominant by default. Phase 0 ships one 2-member cap, so this doesn't
// fire today; surface for the next cap configuration review.
function buildEffectiveContributions(
  contributions: ReadonlyArray<FactorContribution>,
  triggeredCaps: ReadonlyArray<TriggeredOverlapCap>,
): FactorContribution[] {
  if (triggeredCaps.length === 0) return [...contributions];

  const effectiveByKey = new Map<string, number>();
  for (const cap of triggeredCaps) {
    effectiveByKey.set(
      cap.winningFactor,
      cap.winningPoints - cap.absorbedPoints,
    );
    for (const key of cap.presentFactors) {
      if (key !== cap.winningFactor) effectiveByKey.set(key, 0);
    }
  }

  return contributions.map((c) => {
    const eff = effectiveByKey.get(c.key);
    return eff === undefined ? c : { ...c, pointsContributed: eff };
  });
}
