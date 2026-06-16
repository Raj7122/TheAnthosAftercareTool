import type { CalibrationParticipantDTO } from "@anthos/api";

// EC-12 (SAD v1.1) — "Primary Factor" labeling rule.
//   If triggered_invariants[] is non-empty, surface the first invariant's
//   display_label so the specialist understands why the row is in Tier 1
//   despite an otherwise quiet profile. UI MUST NOT hide the invariant
//   trigger (FS v1.12 §F-03).
//   Otherwise, surface the highest-weighted contributing factor's name.
export function primaryFactorLabel(dto: CalibrationParticipantDTO): string {
  const inv = dto.triggeredInvariants[0];
  if (inv !== undefined) {
    return inv.display_label;
  }
  if (dto.highestImpactFactor !== null) {
    return dto.highestImpactFactor.name;
  }
  return "—";
}
