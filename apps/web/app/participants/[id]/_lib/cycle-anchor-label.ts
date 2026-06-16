import type { PerAnchorState } from "@anthos/api";

import type { CycleBadgeVariant } from "../../../_components/participant/cycle-badge-label";

// F-05 BR-33 P1F-07 — per-anchor cycle row label + variant mapping for the
// F-07 detail-page breakdown panel.
//
// Strict BR-33 five-state subset: the aggregate-only `CheckpointState` values
// (`not_in_cycle`, `pre_enrollment`, `between`, `cycle_complete`) cannot reach
// this mapping by type — `PerAnchorState` excludes them at the domain layer.
//
// Reuses the P1D-04 `cycleComplete / cycleDue / cycleOverdue / cycleCatchUp /
// muted` Badge variants — no new tokens. Per-anchor labels stay short ("Due",
// "Overdue", "Catch-up") because the headline caseload badge already carries
// the day-count math; per BR-65 portrait legibility the rows must fit on one
// line at tablet width.

export interface CycleAnchorDisplay {
  readonly label: string;
  readonly variant: CycleBadgeVariant;
}

export function cycleAnchorDisplay(state: PerAnchorState): CycleAnchorDisplay {
  switch (state) {
    case "complete":
      return { label: "Complete", variant: "cycleComplete" };
    case "due":
      return { label: "Due", variant: "cycleDue" };
    case "overdue":
      return { label: "Overdue", variant: "cycleOverdue" };
    case "catch_up":
      return { label: "Catch-up", variant: "cycleCatchUp" };
    case "future":
      return { label: "Future", variant: "muted" };
  }
}
