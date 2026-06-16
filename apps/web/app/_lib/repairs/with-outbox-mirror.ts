// Outbox mirror seam for the Add Repair path (Pattern C/D). Mirrors
// `case-notes/with-outbox-mirror.ts`.
//
// On the tablet field surface a Repair logged offline must survive a dead
// connection, exactly as a Case Note does. This wraps the single-shot
// create-repair mutation in the generic `runWithOutboxMirror` core so an offline
// repair queues to the Outbox and visibly syncs on reconnect. There is NO
// optimistic-reconcile loop; the "reconcile" the core runs is one `createRepair`
// call, passed in by the hook.

import type { CreateRepairInput } from "../../_components/repairs/types";
import type { MutationFailure } from "../../caseload/_lib/send-mutation";
import {
  runWithOutboxMirror,
  type OutboxMirrorDeps,
} from "../offline/outbox-mirror";

// Build the `POST /repairs` body from the sheet input — mirrors
// `useRepairMutation`'s body exactly so the queued mirror and the in-flight
// request (and the reconnect replay) are byte-identical.
export function toRepairRequestBody(
  input: CreateRepairInput,
): Record<string, unknown> {
  return { note: input.note };
}

export async function reconcileRepairWithOutboxMirror(
  deps: OutboxMirrorDeps,
  participantId: string,
  idempotencyKey: string,
  input: CreateRepairInput,
  reconcile: () => Promise<MutationFailure | null>,
): Promise<MutationFailure | null> {
  const endpoint = `/api/v1/participants/${encodeURIComponent(participantId)}/repairs`;
  return runWithOutboxMirror(
    deps,
    endpoint,
    "POST",
    toRepairRequestBody(input),
    idempotencyKey,
    reconcile,
  );
}
