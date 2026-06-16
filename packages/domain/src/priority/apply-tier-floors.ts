import type {
  FactorContribution,
  HydratedParticipant,
  TierInvariant,
  TriggeredInvariant,
} from "./types.js";

// TR-PRIORITY-15/16/17 — post-scoring step that promotes the participant's
// tier when any registered TierInvariant fires.
//
// Spec rule (TRD v1.8 §1786): `final tier = MAX(factor_tier, invariant_tier_floor)`.
// In this codebase Tier 1 = highest priority is numerically `1`, so the
// "max priority" of the spec corresponds to `Math.min` over the tier
// numbers. The factor-math tier is therefore floored *downward* to at most
// `floorTier` whenever an invariant triggers.
//
// Ordering: `triggeredInvariants` preserves the order of `invariants` input.
// Determinism is required by TR-PRIORITY-4 / BR-17.
export function applyTierFloors(
  currentTier: number,
  invariants: ReadonlyArray<TierInvariant>,
  participant: HydratedParticipant,
  contributions: ReadonlyArray<FactorContribution>,
): {
  readonly tier: number;
  readonly triggeredInvariants: ReadonlyArray<TriggeredInvariant>;
} {
  const triggered: TriggeredInvariant[] = [];
  let flooredTier = currentTier;

  for (const invariant of invariants) {
    const result = invariant.check(participant, contributions);
    if (!result.triggered) continue;

    triggered.push({
      invariantId: invariant.id,
      displayLabel: result.label,
      ...(result.triggeringRecordId !== undefined && {
        triggeringRecordId: result.triggeringRecordId,
      }),
    });

    if (result.floorTier < flooredTier) {
      flooredTier = result.floorTier;
    }
  }

  return { tier: flooredTier, triggeredInvariants: triggered };
}
