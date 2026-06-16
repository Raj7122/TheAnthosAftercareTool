// Pattern A optimistic-UI helpers for F-06 Barrier create/close. Pure
// functions only — no fetch, no React, no I/O. The hook in
// `useCaseloadMutations.ts` composes these against component state; tests
// exercise them directly.

import { tierLabelFor } from "@anthos/domain";
import type {
  CaseloadFactor,
  CaseloadItem,
  CaseloadOpenBarrier,
  PriorityRecomputed,
} from "@anthos/api";

// Shape of an optimistic Barrier insert. `severity` is the client's pre-classify
// — the server reclassifies authoritatively, and the reconcile step replaces
// this row with the server's canonical Barrier on success.
export interface OptimisticCreateInput {
  readonly tempBarrierId: string;
  readonly type: string;
  readonly severity: "high" | "medium" | "low" | null;
  readonly openedAtIso: string;
}

// Snapshot the row before mutating so rollback can restore it byte-for-byte
// (Pattern A "Don't roll back silently" — the user-visible state returns to
// exactly the pre-write shape on terminal failure).
export function snapshotRow(
  items: ReadonlyArray<CaseloadItem>,
  participantId: string,
): CaseloadItem | null {
  return items.find((item) => item.participantId === participantId) ?? null;
}

export function applyOptimisticCreate(
  items: ReadonlyArray<CaseloadItem>,
  participantId: string,
  input: OptimisticCreateInput,
): ReadonlyArray<CaseloadItem> {
  return items.map((item) => {
    if (item.participantId !== participantId) return item;
    const optimisticBarrier: CaseloadOpenBarrier = {
      barrierId: input.tempBarrierId,
      type: input.type,
      severity: input.severity,
      openedAt: input.openedAtIso,
      ageDays: 0,
    };
    return { ...item, openBarriers: [...item.openBarriers, optimisticBarrier] };
  });
}

export function applyOptimisticClose(
  items: ReadonlyArray<CaseloadItem>,
  participantId: string,
  barrierId: string,
): ReadonlyArray<CaseloadItem> {
  return items.map((item) => {
    if (item.participantId !== participantId) return item;
    return {
      ...item,
      openBarriers: item.openBarriers.filter(
        (barrier) => barrier.barrierId !== barrierId,
      ),
    };
  });
}

// Replace the row's engine-core fields with the server-side recompute. The
// API §7.4.8 / §7.4.9 `priorityRecomputed` block carries `tier`, `score`, and
// the per-factor breakdown; `tierLabel` is derived deterministically from
// `tier` (FS v1.12 §F-02). `triggered_invariants` and `highestImpactFactor`
// are NOT in the recompute payload — they stay on the pre-write snapshot
// until the next caseload refresh (P1G-01) replaces them in bulk. Surfacing a
// stale invariant for a few seconds beats blanking it on every Barrier write.
export function applyPriorityRecompute(
  items: ReadonlyArray<CaseloadItem>,
  recompute: PriorityRecomputed,
): ReadonlyArray<CaseloadItem> {
  return items.map((item) => {
    if (item.participantId !== recompute.participantId) return item;
    return {
      ...item,
      tier: recompute.tier,
      tierLabel: recompute.tier === null ? null : tierLabelFor(recompute.tier),
      priorityScore: recompute.score,
      factors: recompute.factors.map(toCaseloadFactor),
    };
  });
}

// Replace the temp Barrier inserted by `applyOptimisticCreate` with the
// canonical server-returned Barrier. Used after a successful E-15 round-trip
// so the row's `openBarriers` carries the real Salesforce id (subsequent
// E-16 close calls need it).
export function replaceTempBarrier(
  items: ReadonlyArray<CaseloadItem>,
  participantId: string,
  tempBarrierId: string,
  canonical: CaseloadOpenBarrier,
): ReadonlyArray<CaseloadItem> {
  return items.map((item) => {
    if (item.participantId !== participantId) return item;
    return {
      ...item,
      openBarriers: item.openBarriers.map((barrier) =>
        barrier.barrierId === tempBarrierId ? canonical : barrier,
      ),
    };
  });
}

// Restore the row to its pre-mutation snapshot. The user-visible state must
// return to exactly the shape that preceded the write (Pattern A anti-pattern
// "Don't treat the optimistic record as final once shown").
export function rollbackToSnapshot(
  items: ReadonlyArray<CaseloadItem>,
  snapshot: CaseloadItem,
): ReadonlyArray<CaseloadItem> {
  return items.map((item) =>
    item.participantId === snapshot.participantId ? snapshot : item,
  );
}

// `PriorityRecomputedFactor` and `CaseloadFactor` share the same wire shape
// (API §7.3.1 / §7.4.8) — both omit the engine's internal `trend`.
function toCaseloadFactor(factor: PriorityRecomputed["factors"][number]): CaseloadFactor {
  return {
    key: factor.key,
    name: factor.name,
    valueLabel: factor.valueLabel,
    valueNumeric: factor.valueNumeric,
    weight: factor.weight,
    pointsContributed: factor.pointsContributed,
  };
}
