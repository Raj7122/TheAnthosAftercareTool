import { memo } from "react";

import { Badge } from "@/components/ui/badge";

// P1H-14 — Aftercare Extended program-modifier badge. Renders inline with
// `displayName` in the F-02 caseload row's PARTICIPANT cell when
// `CaseloadItem.aftercareExtended === true` (BR-19(h)).
//
// Single-modifier component for now: FS v1.12 names only one modifier
// (Aftercare Extended checkbox). If a second modifier ever ships, add a
// `kind` prop + branch on the label/title — the chip surface stays one
// component, not a registry of pills. See `ProgramModifierChip.tsx` history
// for the YAGNI rationale (Decision #4 in the P1H-14 plan).
//
// Tooltip uses the native `title=` attribute — matches the codebase pattern
// in `QuickActionsRow.tsx` and `BarrierBadge.tsx`; there is no shared
// Tooltip primitive in `apps/web/components/ui/` to compose against.
function ProgramModifierChipImpl() {
  return (
    <Badge
      variant="programModifier"
      className="rounded-full px-2 py-0.5 text-[11px]"
      title="Aftercare Extended (modifier active)"
      aria-label="Aftercare Extended"
      data-testid="program-modifier-chip-extended"
    >
      Extended
    </Badge>
  );
}

export const ProgramModifierChip = memo(ProgramModifierChipImpl);
