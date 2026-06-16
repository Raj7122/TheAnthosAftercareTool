"use client";

interface Props {
  readonly count: number;
}

// Wireframe `tool-pending-sync` chip — surfaces the count of in-flight
// Pattern A optimistic Barrier mutations exposed by `useCaseloadMutations`
// (`pendingParticipantIds.size`). Hidden at zero so the header stays
// quiet during the steady state.
export function PendingSyncBadge({ count }: Props) {
  if (count <= 0) return null;
  return (
    <span
      role="status"
      data-testid="pending-sync-badge"
      className="inline-flex items-center gap-1 rounded-xl bg-amber-100 px-2.5 py-1 text-[11px] font-medium text-amber-800"
    >
      ⏳ {count} pending
    </span>
  );
}
