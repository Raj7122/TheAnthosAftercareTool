"use client";

// P3C-14 — generic Outbox-mirror core (Pattern C/D). Extracted from the Log
// Call mirror (`_lib/log-call/with-outbox-mirror.ts`) so ANY mutation — Log
// Call, Log Case Note, future actions — gets the same offline-queue lifecycle
// without duplicating the load-bearing terminal-outcome logic:
//
//   1. enqueue the mirror ONCE before firing, carrying the in-flight
//      idempotency key (so a page-side `replayOutbox()` and the SW
//      `BackgroundSyncPlugin` both dedupe to one server write — Pattern D).
//   2. run the caller's reconcile (single-shot or optimistic loop — opaque
//      to this core).
//   3a. confirmed write   → remove the mirror + flash "Synced ✓".
//   3b. NETWORK_ERROR     → leave it queued for the reconnect replay.
//   3c. server-rejected   → drop the mirror (replaying a doomed request would
//                           only duplicate the failure).
//
// The Outbox is keyed by `id === idempotencyKey`, so the pre-fire enqueue is
// idempotent: a repeat submit under the same key `set()`s the same row, never
// a duplicate.

import type { MutationFailure } from "../../caseload/_lib/send-mutation";
import type { EnqueueInput } from "./outbox";
import type { QueuedAction, QueuedActionMethod } from "./types";

export interface OutboxMirrorDeps {
  // Returns the persisted row so a confirmed write can flash it "Synced ✓".
  readonly enqueue: (input: EnqueueInput) => Promise<QueuedAction>;
  // Confirmed write: remove the row AND flash "Synced ✓" (the same honest
  // signal the reconnect replay shows). Wired in the hooks to `flashSynced`.
  readonly markSynced: (row: QueuedAction) => Promise<void>;
  // Server-rejected: remove the row with NO checkmark. Wired to `remove`.
  readonly discard: (id: string) => Promise<void>;
}

export async function runWithOutboxMirror(
  deps: OutboxMirrorDeps,
  endpoint: string,
  method: QueuedActionMethod,
  body: unknown,
  idempotencyKey: string,
  reconcile: () => Promise<MutationFailure | null>,
): Promise<MutationFailure | null> {
  // 1. Mirror BEFORE firing — same key as the in-flight request (Pattern D).
  const action = await deps.enqueue({ endpoint, method, body, idempotencyKey });

  // 2. Run the real reconcile (its internal retries reuse the same key).
  const failure = await reconcile();

  // 3a. Confirmed write — drop the mirror with a "Synced ✓" flash.
  if (failure === null) {
    await deps.markSynced(action);
    return null;
  }
  // 3b. Still offline — keep it queued for the reconnect replay.
  if (failure.code === "NETWORK_ERROR") {
    return failure;
  }
  // 3c. Server-rejected (or exhausted 5xx) — drop the mirror, surface inline.
  await deps.discard(idempotencyKey);
  return failure;
}
