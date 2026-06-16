import type { CaseloadCycleStatus } from "@anthos/api";

// F-05 P1D-04 — caseload-row cycle badge label + variant mapping.
//
// String formatting stays in the UI layer per ticket guidance: the domain
// function returns enum + numbers; the UI turns those into "OVERDUE 12 days".
//
// Variant names map to the `cycle*` Badge variants added in apps/web/
// components/ui/badge.tsx; the BR-33 five-state palette is
// green (complete/between) / grey (boundary states) / orange (due) /
// red (overdue) / purple (catch_up).

export type CycleBadgeVariant =
  | "muted"
  | "cycleComplete"
  | "cycleDue"
  | "cycleOverdue"
  | "cycleCatchUp";

export interface CycleBadgeDisplay {
  readonly label: string;
  readonly variant: CycleBadgeVariant;
}

export function cycleBadgeDisplay(
  cycleStatus: CaseloadCycleStatus,
): CycleBadgeDisplay {
  const { state, daysToNext, daysOverdue } = cycleStatus;
  switch (state) {
    case "not_in_cycle":
      return { label: "Not in cycle", variant: "muted" };
    case "pre_enrollment":
      return { label: "Pre-enrollment", variant: "muted" };
    case "due":
      return {
        label:
          daysToNext === null ? "Due soon" : `Due in ${daysToNext} days`,
        variant: "cycleDue",
      };
    case "overdue":
      return {
        label: `OVERDUE ${daysOverdue} days`,
        variant: "cycleOverdue",
      };
    case "catch_up":
      return {
        label: `OVERDUE ${daysOverdue} days`,
        variant: "cycleCatchUp",
      };
    case "complete":
      return { label: "Done", variant: "cycleComplete" };
    case "between":
      return { label: "On track", variant: "cycleComplete" };
    case "cycle_complete":
      return { label: "Cycle complete", variant: "muted" };
    case "future":
      // Per-anchor-only state (types.ts:18). The aggregate function never
      // emits it for the caseload row; the type system allows it, so render
      // a neutral label rather than blowing up.
      return { label: "Future", variant: "muted" };
  }
}
