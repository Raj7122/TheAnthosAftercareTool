import type {
  FactorContribution,
  HydratedParticipant,
  TierInvariant,
  TierInvariantCheckResult,
} from "../types.js";

// Factory for BR-26 (TR-PRIORITY-17) — habitability / building-condition
// invariant: ≥1 open Barrier with the configured `Type` and
// `Stage='Aftercare'` forces the participant to Tier 1.
//
// This factory once also served BR-25 ("open repair"), but P0-04e pivoted
// BR-25 off the Barriers picklist onto the dedicated `Repair__c` object
// (see invariants/open-repair.ts); it now serves BR-26 only.
//
// Reads `participant.open_barriers[]` — the same field the BR-19(e) factor
// consumes. Each entry is expected to carry `{ id?, type?, stage? }`; the
// invariant is defensive against hydration drift (missing fields = no
// trigger) so a partial hydration cannot crash the engine. Fail-loud
// happens upstream at engine-construction time in `getActiveInvariants()`
// when the M-CONFIG mapping references a Barrier Type that is not in the
// current Salesforce picklist enum cache.
const AFTERCARE_STAGE = "Aftercare";

interface OpenBarrier {
  readonly id?: unknown;
  readonly type?: unknown;
  readonly stage?: unknown;
}

export interface BarrierTypeInvariantOptions {
  readonly invariantId: string;
  readonly barrierType: string;
  readonly displayLabel: string;
  readonly floorTier?: number;
}

export function createBarrierTypeInvariant(
  options: BarrierTypeInvariantOptions,
): TierInvariant {
  const floorTier = options.floorTier ?? 1;

  return {
    id: options.invariantId,
    check(
      participant: HydratedParticipant,
      _contributions: ReadonlyArray<FactorContribution>,
    ): TierInvariantCheckResult {
      const raw = participant["open_barriers"];
      if (!Array.isArray(raw)) {
        return { triggered: false, label: options.displayLabel, floorTier };
      }

      for (const entry of raw as ReadonlyArray<OpenBarrier>) {
        if (
          entry.type === options.barrierType &&
          entry.stage === AFTERCARE_STAGE
        ) {
          const id = typeof entry.id === "string" ? entry.id : undefined;
          return {
            triggered: true,
            label: options.displayLabel,
            floorTier,
            ...(id !== undefined && { triggeringRecordId: id }),
          };
        }
      }

      return { triggered: false, label: options.displayLabel, floorTier };
    },
  };
}
