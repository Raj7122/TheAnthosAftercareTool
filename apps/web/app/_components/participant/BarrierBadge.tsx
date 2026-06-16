"use client";

import type { CaseloadOpenBarrier } from "@anthos/api";

import { Badge } from "@/components/ui/badge";

import { barrierBadgeVariant } from "./barrier-badge-variant";

interface Props {
  readonly barrier: CaseloadOpenBarrier;
}

// One open-Barrier badge for the caseload row (F-06 BR-38). The Type label
// is shown directly; severity tier maps to background color via the palette.
// The native `title` carries the age-in-days context so a hover/long-press
// reveals it without occupying row width.
export function BarrierBadge({ barrier }: Props) {
  const variant = barrierBadgeVariant(barrier.severity);
  const label = barrier.type ?? "Unclassified";
  const title =
    barrier.ageDays === null ? label : `${label} — open ${barrier.ageDays}d`;
  return (
    <Badge variant={variant} title={title} aria-label={title}>
      {label}
    </Badge>
  );
}
