"use client";

import { useCallback, useState } from "react";

import { newIdempotencyKey } from "@anthos/domain";

import {
  sendMutation,
  type FetchLike,
  type MutationFailure,
} from "../../caseload/_lib/send-mutation";
import type { CreateRepairInput } from "./types";

// The fields the create-Repair BFF echoes back (subset of CreateRepairResponseBody
// in `@anthos/api`, redeclared locally so this client module never value-imports
// `@anthos/api` — bundle discipline, same as the calendar libs).
export interface RepairServerRecord {
  readonly repairId: string;
  readonly participantId: string;
  readonly identificationDate: string;
  readonly note: string;
  readonly loggedAt: string;
}

export type CreateRepairResult =
  | { readonly outcome: "success"; readonly record: RepairServerRecord }
  | { readonly outcome: "failure"; readonly failure: MutationFailure };

// Pattern D — the Idempotency-Key is minted once per submit by default. Callers
// with an in-flight Outbox mirror (the tablet offline path) pass an externally-
// minted `idempotencyKey` so the mirror, the in-flight request, and the
// reconnect replay all carry the SAME key and dedupe to one Repair__c. The sheet
// disables its Submit while a request is in flight, so a key is never reused for
// a second create of the same note; a user-driven re-submit after a failure is a
// fresh intent and correctly mints a fresh key.
export function useRepairMutation(opts?: { readonly fetchImpl?: FetchLike }) {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const [isPending, setIsPending] = useState(false);

  const createRepair = useCallback(
    async (
      participantId: string,
      input: CreateRepairInput,
      idempotencyKey?: string,
    ): Promise<CreateRepairResult> => {
      setIsPending(true);
      try {
        const outcome = await sendMutation(fetchImpl, {
          method: "POST",
          url: `/api/v1/participants/${encodeURIComponent(participantId)}/repairs`,
          idempotencyKey: idempotencyKey ?? newIdempotencyKey(),
          body: { note: input.note },
        });
        if (outcome.kind === "failure") {
          return { outcome: "failure", failure: outcome.failure };
        }
        return {
          outcome: "success",
          record: outcome.body as RepairServerRecord,
        };
      } finally {
        setIsPending(false);
      }
    },
    [fetchImpl],
  );

  return { isPending, createRepair };
}
