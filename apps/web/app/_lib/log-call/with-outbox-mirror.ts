// P3C-13 — Outbox mirror seam for the Log Call path (Pattern C/D).
//
// Thin wrapper over the generic `runWithOutboxMirror` core (P3C-14,
// `_lib/offline/outbox-mirror.ts`): this file owns only what is Log-Call-
// specific — the `/calls` endpoint and the `toLogCallRequestBody` builder —
// and delegates the enqueue-before-fire / terminal-outcome lifecycle to the
// core. The public signature (`reconcileWithOutboxMirror`) and the
// `OutboxMirrorDeps` shape (which carries `reconcile`) are preserved so
// `use-log-call-reconciler.ts` and the existing tests are unchanged.
//
// Lifecycle (delegated to the core): enqueue `pending_sync` BEFORE firing with
// the in-flight key → run `reconcileLogCall` → SUCCESS removes the mirror with
// a "Synced ✓" flash; NETWORK_ERROR leaves it queued for the reconnect replay;
// a non-network failure (authz 403, VR-18 422, exhausted 5xx) drops the mirror
// and surfaces inline. See the core for the full rationale.

import type { LogCallInput } from "../../caseload/_lib/useLogCallMutation";
import type { MutationFailure } from "../../caseload/_lib/send-mutation";
import type { EnqueueInput } from "../offline/outbox";
import type { QueuedAction } from "../offline/types";
import { runWithOutboxMirror } from "../offline/outbox-mirror";

export type ReconcileFn = (
  participantId: string,
  idempotencyKey: string,
  input: LogCallInput,
) => Promise<MutationFailure | null>;

export interface OutboxMirrorDeps {
  // Returns the persisted row so a confirmed write can flash it "Synced ✓".
  readonly enqueue: (input: EnqueueInput) => Promise<QueuedAction>;
  // Confirmed write: remove the row AND flash "Synced ✓" (same honest signal
  // the reconnect replay shows). Defaults in the hook to `flashSynced`.
  readonly markSynced: (row: QueuedAction) => Promise<void>;
  // Server-rejected: remove the row with NO checkmark. Defaults to `remove`.
  readonly discard: (id: string) => Promise<void>;
  readonly reconcile: ReconcileFn;
}

// Build the `POST /calls` body from the sheet input. Mirrors
// `useLogCallMutation.submitLogCall` exactly: the three required fields plus
// `summary` only when non-empty (the server treats absent + empty distinctly
// for VR-18). Kept in lockstep with that builder.
export function toLogCallRequestBody(input: LogCallInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    status: input.status,
    type: input.type,
    serviceDate: input.serviceDate,
  };
  if (input.summary !== undefined && input.summary.length > 0) {
    body.summary = input.summary;
  }
  return body;
}

export async function reconcileWithOutboxMirror(
  deps: OutboxMirrorDeps,
  participantId: string,
  idempotencyKey: string,
  input: LogCallInput,
): Promise<MutationFailure | null> {
  const endpoint = `/api/v1/participants/${encodeURIComponent(participantId)}/calls`;
  return runWithOutboxMirror(
    { enqueue: deps.enqueue, markSynced: deps.markSynced, discard: deps.discard },
    endpoint,
    "POST",
    toLogCallRequestBody(input),
    idempotencyKey,
    () => deps.reconcile(participantId, idempotencyKey, input),
  );
}
