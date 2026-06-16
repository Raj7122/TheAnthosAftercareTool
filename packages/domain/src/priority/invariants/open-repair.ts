import type {
  FactorContribution,
  HydratedParticipant,
  TierInvariant,
  TierInvariantCheckResult,
} from "../types.js";

// BR-25 (TR-PRIORITY-16) — open-repair categorical Tier 1 invariant. ≥1 open
// Post-Move-In repair forces the participant to Tier 1. Floor-not-cap: the
// participant may score higher via factor math but cannot score lower.
//
// Data-source pivot (P0-04e): BR-25 used to ride the shared
// `createBarrierTypeInvariant` factory against a `Repair pending` Barrier
// Type. Julia closed that 2026-05-19 — repairs live on a dedicated `Repair__c`
// object. The rule is unchanged; only the upstream read moves. Unlike BR-26,
// BR-25 has no engine-construction fail-loud check — it no longer depends on
// the Salesforce Barrier Type picklist enum cache.
//
// NOTE: TRD v1.8 TR-PRIORITY-16 (and FS v1.12 BR-25) still describe the
// Barrier-Type data source. The categorical floor rule is unchanged; only the
// read moves. The spec text is stale pending a `spec/` erratum sibling ticket
// (see the P0-04e ticket's Open GAP flags) — this code follows Julia's
// 2026-05-19 decision, which supersedes it.
//
// Reads `participant.repairs[]` — the P0-04 mapping layer's domain-local
// projection of the `RepairSnapshot` collection the bulk-hydration adapter
// hydrates. Each entry is expected to carry `{ id?, status?, preOrPostMoveIn? }`;
// the invariant is defensive against hydration drift (missing field = no
// trigger) so a partial hydration cannot crash the engine.

// Q-R1 — terminal `Repair__c.Status__c` values: a repair in either state is
// closed and does NOT trigger the floor. Encoded as a terminal set (not an
// open set) so a future picklist value defaults to "open" — failing toward
// surfacing the Tier 1 floor. `Ready for Final Inspection` is therefore "open"
// by default (Q-R1 default = yes). Erick confirmation is a one-line flip:
// add the literal here to reclassify a status as closed.
const TERMINAL_REPAIR_STATUS = new Set<string>(["Completed", "Canceled"]);

// Q-R2 — only Post-Move-In repairs are an Aftercare advocacy concern;
// Pre-Move-In repairs are ignored. `Pre_or_Post_Move_In__c` is a Salesforce
// formula emitting exactly `"Pre Move-In"` / `"Post Move-In"`. One-line flip
// if Erick reclassifies.
const AFTERCARE_REPAIR_PHASE = "Post Move-In";

// Domain-local input shape — packages/domain stays pure and free of any
// @anthos/integrations dependency, so the invariant declares the three fields
// it reads rather than importing RepairSnapshot. Mirrors OpenBarrier in
// barrier-type.ts and ArrearInput in factors/arrears.ts.
interface RepairInput {
  readonly id?: unknown;
  readonly status?: unknown;
  readonly preOrPostMoveIn?: unknown;
}

export interface OpenRepairInvariantOptions {
  readonly invariantId: string;
  readonly displayLabel: string;
  readonly floorTier?: number;
}

export function createOpenRepairInvariant(
  options: OpenRepairInvariantOptions,
): TierInvariant {
  const floorTier = options.floorTier ?? 1;

  return {
    id: options.invariantId,
    check(
      participant: HydratedParticipant,
      _contributions: ReadonlyArray<FactorContribution>,
    ): TierInvariantCheckResult {
      const raw = participant["repairs"];
      if (!Array.isArray(raw)) {
        return { triggered: false, label: options.displayLabel, floorTier };
      }

      for (const entry of raw as ReadonlyArray<RepairInput>) {
        if (
          typeof entry.status === "string" &&
          !TERMINAL_REPAIR_STATUS.has(entry.status) &&
          entry.preOrPostMoveIn === AFTERCARE_REPAIR_PHASE
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
