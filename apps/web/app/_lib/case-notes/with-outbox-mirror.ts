// P3C-14 — Outbox mirror seam for the Log Case Note path (Pattern C/D).
//
// Case Note is the offline-first field-documentation action: a specialist
// logging a note from the field must have it survive a dead connection. This
// wraps the single-shot create-case-note mutation in the generic
// `runWithOutboxMirror` core so an offline note queues to the Outbox and
// visibly syncs on reconnect — exactly as Log Call does. Unlike Log Call there
// is NO optimistic-reconcile loop; the "reconcile" the core runs is one
// `createCaseNote` call, passed in by the hook.

import type { CreateCaseNoteInput } from "../../_components/case-notes/types";
import type { MutationFailure } from "../../caseload/_lib/send-mutation";
import {
  runWithOutboxMirror,
  type OutboxMirrorDeps,
} from "../offline/outbox-mirror";

// Build the `POST /case-notes` body from the sheet input — mirrors
// `useCaseNoteMutation`'s body exactly so the queued mirror and the in-flight
// request (and the reconnect replay) are byte-identical.
export function toCaseNoteRequestBody(
  input: CreateCaseNoteInput,
): Record<string, unknown> {
  return {
    note: input.note,
    contactType: input.contactType,
    type: input.type,
    status: input.status,
  };
}

export async function reconcileCaseNoteWithOutboxMirror(
  deps: OutboxMirrorDeps,
  participantId: string,
  idempotencyKey: string,
  input: CreateCaseNoteInput,
  reconcile: () => Promise<MutationFailure | null>,
): Promise<MutationFailure | null> {
  const endpoint = `/api/v1/participants/${encodeURIComponent(participantId)}/case-notes`;
  return runWithOutboxMirror(
    deps,
    endpoint,
    "POST",
    toCaseNoteRequestBody(input),
    idempotencyKey,
    reconcile,
  );
}
