"use client";

// P3C-12 — F-14 offline-queue inspector. Reuses `ActionSheetShell` so
// the tablet PWA gets a true bottom drawer (F-13 portrait-fit) and the
// desktop iframe gets a centered modal, with focus trap, Escape-to-
// dismiss, and body scroll-lock all inherited.
//
// One resolve form per item — only one row may be in flight at a time
// (`submittingId`), and while a row is in flight the shell sets
// `dismissDisabled` so Escape and the backdrop no-op. The inspector
// itself owns no fetch state; refresh on success is the parent hook's
// responsibility (`useQueuePending.resolve`).

import { useId, useState } from "react";

import type { QueuePendingItem, QueueResolveRequest } from "@anthos/api";

import { ActionSheetShell } from "@/components/ui/action-sheet-shell";

import type { ResolveOutcome } from "../../_lib/offline/queue-pending-client";

import { OfflineQueueItemRow } from "./OfflineQueueItemRow";

interface Props {
  readonly items: ReadonlyArray<QueuePendingItem>;
  readonly onClose: () => void;
  readonly onResolve: (input: {
    readonly queueItemId: string;
    readonly request: QueueResolveRequest;
  }) => Promise<ResolveOutcome>;
}

export function OfflineQueueInspector({ items, onClose, onResolve }: Props) {
  const titleId = useId();
  const [submittingId, setSubmittingId] = useState<string | null>(null);

  return (
    <ActionSheetShell
      titleId={titleId}
      onCancel={onClose}
      dismissDisabled={submittingId !== null}
    >
      <h2 id={titleId} className="text-lg font-semibold">
        Pending offline actions
      </h2>
      {items.length === 0 ? (
        <p
          data-testid="offline-queue-inspector-empty"
          className="mt-4 text-sm text-muted-foreground"
        >
          No pending items. You&apos;re all caught up.
        </p>
      ) : (
        <ul
          data-testid="offline-queue-inspector-list"
          className="mt-4 space-y-4"
        >
          {items.map((item) => (
            <li key={item.queueItemId}>
              <OfflineQueueItemRow
                item={item}
                submitting={submittingId === item.queueItemId}
                disabled={
                  submittingId !== null && submittingId !== item.queueItemId
                }
                onResolve={async (request) => {
                  setSubmittingId(item.queueItemId);
                  try {
                    return await onResolve({
                      queueItemId: item.queueItemId,
                      request,
                    });
                  } finally {
                    setSubmittingId(null);
                  }
                }}
              />
            </li>
          ))}
        </ul>
      )}
      <div className="mt-6 flex justify-end">
        <button
          type="button"
          onClick={onClose}
          disabled={submittingId !== null}
          data-testid="offline-queue-inspector-close"
          className="rounded-md px-4 py-2 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-50"
        >
          Close
        </button>
      </div>
    </ActionSheetShell>
  );
}
