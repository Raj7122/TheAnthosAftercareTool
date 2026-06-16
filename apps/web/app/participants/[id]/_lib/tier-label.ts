import { tierLabelFor } from "@anthos/domain";

// SPA-side tier-label derivation for the F-07 priority card. Delegates to
// `@anthos/domain`'s `tierLabelFor` so the detail page and the caseload row
// surface the SAME spec-canonical strings ("Act today" / "Act this week" /
// "Routine" per FS v1.12 §F-02 line 400). A SPA-side hand-rolled "Tier N"
// would drift from the caseload row's `tierLabel` field (which is engine-
// produced via the same domain helper). Promotion to a server-side
// `tierLabel` on `ParticipantDetailBody` is the longer-term path (P1F-08
// plan §Decisions) — until a second consumer appears, this delegation keeps
// parity for free.
export function tierLabel(tier: number | null): string | null {
  if (tier === null) return null;
  if (tier === 1 || tier === 2 || tier === 3) return tierLabelFor(tier);
  return null;
}
