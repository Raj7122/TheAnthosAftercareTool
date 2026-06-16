"use client";

// P3C-12 — F-14 persistent, tappable offline-queue indicator.
//
// Mounted globally in `apps/web/app/layout.tsx` so it persists across
// navigation (BR-66/67). Renders `null` when:
//   - the queue has zero items (BR-67 "always visible when ≥1 pending")
//   - the session is unauthenticated (401) or the role is not SPECIALIST
//     (403) — both surface as a hidden chip so login/landing routes and
//     non-SPECIALIST roles see no indicator.
//   - the hook is still loading the first response (avoid flashing a chip
//     before the count is known).
//
// Position: fixed top-right at `z-40`. ActionSheetShell uses `z-50`, so
// opening the inspector overlays the chip cleanly. The chip is a
// rounded-full pill in amber to read as "needs attention" without
// shouting "error" — distinct from `PendingSyncBadge` (in-flight
// Pattern A mutations) which lives inside the caseload header.

import { useState } from "react";

import {
  useQueuePending,
  type UseQueuePendingOptions,
} from "../../_lib/offline/use-queue-pending";

import { OfflineQueueInspector } from "./OfflineQueueInspector";

interface Props {
  // Test seams — undefined in production. Defaults inside the hook use
  // `globalThis.fetch` and `crypto.randomUUID()`.
  readonly fetchImpl?: UseQueuePendingOptions["fetchImpl"];
  readonly mintIdempotencyKey?: UseQueuePendingOptions["mintIdempotencyKey"];
}

export function OfflineQueueIndicator({
  fetchImpl,
  mintIdempotencyKey,
}: Props = {}) {
  // `exactOptionalPropertyTypes` rejects passing `undefined` explicitly —
  // conditionally spread so absent test seams stay absent in the options
  // object the hook receives.
  const queue = useQueuePending({
    ...(fetchImpl !== undefined ? { fetchImpl } : {}),
    ...(mintIdempotencyKey !== undefined ? { mintIdempotencyKey } : {}),
  });
  const [open, setOpen] = useState(false);

  if (
    queue.status === "loading" ||
    queue.status === "unauthenticated" ||
    queue.status === "forbidden"
  ) {
    return null;
  }
  if (queue.count <= 0) return null;

  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${queue.count} pending offline-queue items`}
        data-testid="offline-queue-indicator"
        onClick={() => setOpen(true)}
        className="fixed right-4 top-4 z-40 inline-flex items-center gap-1.5 rounded-full bg-amber-100 px-3 py-1.5 text-xs font-medium text-amber-900 shadow ring-1 ring-amber-300/60 hover:bg-amber-200"
      >
        <span aria-hidden="true">⚠</span>
        <span>{queue.count} pending</span>
      </button>
      {open && (
        <OfflineQueueInspector
          items={queue.items}
          onClose={() => setOpen(false)}
          onResolve={queue.resolve}
        />
      )}
    </>
  );
}
