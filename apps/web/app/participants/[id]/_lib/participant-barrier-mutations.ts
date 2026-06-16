// Pattern A optimistic-UI helpers for F-06 Barrier create/close on the F-07
// participant detail page. Pure functions only — no fetch, no React, no I/O.
// The hook in `useParticipantBarrierMutations.ts` composes these against
// component state; tests exercise them directly.
//
// Mirror of `apps/web/app/caseload/_lib/caseload-mutations.ts` but operating
// on `ParticipantDetailBody` (a single participant) instead of
// `CaseloadItem[]`. The two diverge in field names — `currentTier` /
// `currentPriorityScore` vs `tier` / `priorityScore` — and the detail body
// carries `priorityModifier`, `highestImpactFactor`, and
// `triggered_invariants` that `priorityRecomputed` does NOT echo back.

import type {
  CaseloadFactor,
  CaseloadOpenBarrier,
  ParticipantDetailBody,
  PriorityRecomputed,
} from "@anthos/api";

// Shape of an optimistic Barrier insert. `severity` is the client's
// pre-classify — the server reclassifies authoritatively, and the reconcile
// step replaces this row with the server's canonical Barrier on success.
export interface OptimisticCreateInput {
  readonly tempBarrierId: string;
  readonly type: string;
  readonly severity: "high" | "medium" | "low" | null;
  readonly openedAtIso: string;
}

// Snapshot of the mutable slice the helpers touch — enough to byte-for-byte
// restore on rollback. `triggered_invariants`, `priorityModifier`, and
// `highestImpactFactor` are not in this snapshot because the helpers never
// write them; the rollback path leaves them untouched too.
export interface DetailMutationSnapshot {
  readonly currentTier: number | null;
  readonly currentPriorityScore: number | null;
  readonly factors: ReadonlyArray<CaseloadFactor>;
  readonly openBarriers: ReadonlyArray<CaseloadOpenBarrier>;
}

export function snapshotDetailBody(
  body: ParticipantDetailBody,
): DetailMutationSnapshot {
  return {
    currentTier: body.currentTier,
    currentPriorityScore: body.currentPriorityScore,
    factors: body.factors,
    openBarriers: body.openBarriers,
  };
}

export function applyOptimisticCreate(
  body: ParticipantDetailBody,
  input: OptimisticCreateInput,
): ParticipantDetailBody {
  const optimisticBarrier: CaseloadOpenBarrier = {
    barrierId: input.tempBarrierId,
    type: input.type,
    severity: input.severity,
    openedAt: input.openedAtIso,
    ageDays: 0,
  };
  return { ...body, openBarriers: [...body.openBarriers, optimisticBarrier] };
}

export function applyOptimisticClose(
  body: ParticipantDetailBody,
  barrierId: string,
): ParticipantDetailBody {
  return {
    ...body,
    openBarriers: body.openBarriers.filter(
      (barrier) => barrier.barrierId !== barrierId,
    ),
  };
}

// Replace the engine-core priority fields with the server-side recompute.
// `priorityRecomputed` carries `score`, `tier`, and the per-factor breakdown
// — but NOT `priorityModifier`, `highestImpactFactor`, or
// `triggered_invariants`. Those stay on the pre-write snapshot until the
// next caseload refresh (P1G-01) replaces them in bulk; surfacing a stale
// invariant or modifier for a few seconds beats blanking it on every write
// (same posture as caseload-mutations).
export function applyPriorityRecompute(
  body: ParticipantDetailBody,
  recompute: PriorityRecomputed,
): ParticipantDetailBody {
  if (recompute.participantId !== body.participantId) return body;
  return {
    ...body,
    currentTier: recompute.tier,
    currentPriorityScore: recompute.score,
    factors: recompute.factors.map(toCaseloadFactor),
  };
}

export function replaceTempBarrier(
  body: ParticipantDetailBody,
  tempBarrierId: string,
  canonical: CaseloadOpenBarrier,
): ParticipantDetailBody {
  return {
    ...body,
    openBarriers: body.openBarriers.map((barrier) =>
      barrier.barrierId === tempBarrierId ? canonical : barrier,
    ),
  };
}

export function rollbackToSnapshot(
  body: ParticipantDetailBody,
  snapshot: DetailMutationSnapshot,
): ParticipantDetailBody {
  return {
    ...body,
    currentTier: snapshot.currentTier,
    currentPriorityScore: snapshot.currentPriorityScore,
    factors: snapshot.factors,
    openBarriers: snapshot.openBarriers,
  };
}

function toCaseloadFactor(
  factor: PriorityRecomputed["factors"][number],
): CaseloadFactor {
  return {
    key: factor.key,
    name: factor.name,
    valueLabel: factor.valueLabel,
    valueNumeric: factor.valueNumeric,
    weight: factor.weight,
    pointsContributed: factor.pointsContributed,
  };
}
