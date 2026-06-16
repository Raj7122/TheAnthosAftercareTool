import type { CaseloadCycleStatus } from "@anthos/api";

import { Badge } from "@/components/ui/badge";

import { cycleBadgeDisplay } from "./cycle-badge-label";

interface Props {
  readonly cycleStatus: CaseloadCycleStatus;
}

// F-05 caseload-row headline badge (P1D-04). Reads the wire-DTO cycle
// status, maps it to label + Badge variant via `cycleBadgeDisplay`, and
// renders a fixed-width Badge so column widths stay stable across rows.
// BR-65 portrait-legibility: short labels, single line.
export function CycleBadge({ cycleStatus }: Props) {
  const { label, variant } = cycleBadgeDisplay(cycleStatus);
  return (
    <Badge
      variant={variant}
      aria-label={`Stability visit cycle: ${label}`}
      className="h-6 min-w-[4rem] justify-center"
    >
      {label}
    </Badge>
  );
}
