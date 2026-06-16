"use client";

import type { QueuePendingItem, QueueResolveRequest } from "@anthos/api";

import type { OutboxUiStatus } from "../../_lib/offline/replay";

import { ReviewRequiredItem } from "./ReviewRequiredItem";

// P3C-13 — F-14 Pending Sync surface, now dual-source and LIVE. Two kinds of
// row, two sources of truth:
//   - "syncing" rows come from the client Outbox (`useOutbox`): a Log Call
//     queued offline, mid-replay, or just-confirmed (the brief "Synced ✓").
//   - "review_required" rows come from the server `offline_queue`
//     (`useQueuePending`): conflicts Salesforce rejected that need a decision.
// Visible-but-non-blocking by design — sync state sits below the primary CTA
// without stealing the next-action surface.

export type PendingSyncRow = {
  readonly kind: "syncing";
  readonly id: string;
  readonly title: string;
  readonly meta: string;
  readonly uiStatus: OutboxUiStatus;
};

export type PendingReviewRow = {
  readonly kind: "review_required";
  readonly item: QueuePendingItem;
};

export type PendingRow = PendingSyncRow | PendingReviewRow;

interface Props {
  readonly rows: ReadonlyArray<PendingRow>;
  readonly onResolve: (
    queueItemId: string,
    request: QueueResolveRequest,
  ) => void;
}

const STATUS_COPY: Record<OutboxUiStatus, string> = {
  pending_sync: "Queued · will sync when back online",
  syncing: "Syncing…",
  synced: "Synced ✓",
};

function syncingRowClass(status: OutboxUiStatus): string {
  if (status === "synced") {
    return "rounded-md bg-emerald-50 p-2.5 text-xs";
  }
  return "rounded-md bg-tabletPendingBg p-2.5 text-xs";
}

export function PendingQueuePanel({ rows, onResolve }: Props) {
  // Count of work genuinely still waiting (excludes the "synced" flash).
  const waitingCount = rows.filter(
    (row) => row.kind === "review_required" || row.uiStatus !== "synced",
  ).length;

  return (
    <section
      className="mx-4 rounded-lg border border-tabletPending bg-white p-3.5"
      data-testid="pending-queue-panel"
    >
      <h2 className="mb-2.5 flex items-center gap-1.5 text-[13px] font-bold text-[#78350f]">
        <span aria-hidden="true">⚡</span>
        {waitingCount === 0
          ? "Nothing waiting to sync"
          : `${waitingCount} ${waitingCount === 1 ? "action" : "actions"} queued — will sync when back online`}
      </h2>
      {rows.length === 0 ? (
        <p
          className="text-[11px] text-zinc-500"
          data-testid="pending-queue-empty"
        >
          Queued actions appear here while offline and clear when they sync.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((row) =>
            row.kind === "review_required" ? (
              <li key={`review-${row.item.queueItemId}`}>
                <ReviewRequiredItem item={row.item} onResolve={onResolve} />
              </li>
            ) : (
              <li key={`sync-${row.id}`}>
                <div
                  className={syncingRowClass(row.uiStatus)}
                  data-testid="pending-queue-syncing-item"
                  data-ui-status={row.uiStatus}
                >
                  <p className="mb-0.5 font-semibold text-[#78350f]">
                    {row.title}
                  </p>
                  <p className="text-[11px] text-[#92400e]">
                    {row.meta} · {STATUS_COPY[row.uiStatus]}
                  </p>
                </div>
              </li>
            ),
          )}
        </ul>
      )}
    </section>
  );
}
