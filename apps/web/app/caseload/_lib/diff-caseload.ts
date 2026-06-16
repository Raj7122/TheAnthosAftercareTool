import type { CaseloadItem } from "@anthos/api";

import { primaryFactorLabel } from "../../_components/participant/primary-factor";

// Pure diff over the engine-visible row signature: tier, priority score, and
// EC-12 primary-factor label. A change in any of those is what the F-16
// "tool is alive" beat needs to surface — a position-only re-sort (same tier
// + same score + same primary factor) does NOT trigger the highlight.
//
// Participants newly present in `next` are returned as changed (specialist
// can't see "this row moved in" without an indicator). Removed participants
// are absent from `next` so there's nothing to highlight — they're already
// gone from the rendered list.
//
// `primaryFactorLabel` from ./primary-factor is the single source of truth
// for which label the row surfaces (invariant label vs. highest-impact
// factor name) — using it here keeps the diff aligned with what the row
// actually renders, even when triggered_invariants drive the label.
export function computeDiff(
  prev: ReadonlyArray<CaseloadItem>,
  next: ReadonlyArray<CaseloadItem>,
): ReadonlySet<string> {
  const changed = new Set<string>();
  const prevByPid = new Map<string, CaseloadItem>();
  for (const p of prev) prevByPid.set(p.participantId, p);

  for (const n of next) {
    const p = prevByPid.get(n.participantId);
    if (p === undefined) {
      changed.add(n.participantId);
      continue;
    }
    if (
      p.tier !== n.tier ||
      p.priorityScore !== n.priorityScore ||
      primaryFactorLabel({
        highestImpactFactor: p.highestImpactFactor,
        triggeredInvariants: p.triggered_invariants,
      }) !==
        primaryFactorLabel({
          highestImpactFactor: n.highestImpactFactor,
          triggeredInvariants: n.triggered_invariants,
        })
    ) {
      changed.add(n.participantId);
    }
  }
  return changed;
}
