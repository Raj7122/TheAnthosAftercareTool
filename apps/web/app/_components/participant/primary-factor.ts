import type {
  CaseloadHighestImpactFactor,
  CaseloadTriggeredInvariant,
} from "@anthos/api";

// EC-12 (FS v1.12 §F-03) — "Primary Factor" labeling rule.
//   If `triggeredInvariants` is non-empty, surface the first invariant's
//   `display_label` so the specialist understands why the row is in Tier 1
//   despite an otherwise quiet profile. UI MUST NOT hide the invariant
//   trigger.
//   Otherwise, surface the highest-impact contributing factor's name.
//
// Structurally typed so the caseload row (`CaseloadItem`) and the
// participant detail body (`ParticipantDetailBody`) both call this with
// `{ highestImpactFactor: x.highestImpactFactor, triggeredInvariants:
// x.triggered_invariants }`.
//
// EC-12 PARITY WARNING: calibration carries its own twin in
// `app/calibration/_lib/primary-factor.ts` (typed against the calibration
// wire DTO with camelCase `triggeredInvariants`). The two implementations
// share the EC-12 rule — invariant label wins over highest-impact factor —
// so any behavioral change here MUST land in lockstep with the calibration
// twin. P1F-08 deliberately deferred retargeting calibration to keep the
// ticket scoped; a follow-up should converge them once a third consumer
// appears (or sooner if EC-12 needs to evolve).
export interface PrimaryFactorInput {
  readonly highestImpactFactor: CaseloadHighestImpactFactor | null;
  readonly triggeredInvariants: ReadonlyArray<CaseloadTriggeredInvariant>;
}

export function primaryFactorLabel(input: PrimaryFactorInput): string {
  const invariant = input.triggeredInvariants[0];
  if (invariant !== undefined) {
    return invariant.display_label;
  }
  if (input.highestImpactFactor !== null) {
    return input.highestImpactFactor.name;
  }
  return "—";
}
