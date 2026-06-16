"use client";

import { useCallback, useState } from "react";

import { newIdempotencyKey } from "@anthos/domain";

import {
  sendMutation,
  type FetchLike,
  type MutationFailure,
} from "../../caseload/_lib/send-mutation";
import type { CreateCaseNoteInput } from "./types";

// Fields the create-case-note BFF echoes back (subset of
// CreateCaseNoteResponseBody, redeclared locally so this client module never
// value-imports `@anthos/api`).
export interface CaseNoteServerRecord {
  readonly caseNoteId: string;
  readonly participantId: string;
  readonly serviceDate: string;
  readonly note: string;
  readonly contactType: string;
  readonly type: string;
  readonly status: string;
  readonly loggedAt: string;
}

export type CreateCaseNoteResult =
  | { readonly outcome: "success"; readonly record: CaseNoteServerRecord }
  | { readonly outcome: "failure"; readonly failure: MutationFailure };

// Pattern D — the Idempotency-Key is minted once per submit by default. Callers
// with an in-flight Outbox mirror (the tablet offline path, P3C-14) pass an
// externally-minted `idempotencyKey` so the mirror, the in-flight request, and
// the reconnect replay all carry the SAME key and dedupe to one
// IDW_Case_Note__c. The sheet disables Submit while in flight, so a key is
// never reused for a second create.
export function useCaseNoteMutation(opts?: { readonly fetchImpl?: FetchLike }) {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const [isPending, setIsPending] = useState(false);

  const createCaseNote = useCallback(
    async (
      participantId: string,
      input: CreateCaseNoteInput,
      idempotencyKey?: string,
    ): Promise<CreateCaseNoteResult> => {
      setIsPending(true);
      try {
        const outcome = await sendMutation(fetchImpl, {
          method: "POST",
          url: `/api/v1/participants/${encodeURIComponent(participantId)}/case-notes`,
          idempotencyKey: idempotencyKey ?? newIdempotencyKey(),
          body: {
            note: input.note,
            contactType: input.contactType,
            type: input.type,
            status: input.status,
          },
        });
        if (outcome.kind === "failure") {
          return { outcome: "failure", failure: outcome.failure };
        }
        return {
          outcome: "success",
          record: outcome.body as CaseNoteServerRecord,
        };
      } finally {
        setIsPending(false);
      }
    },
    [fetchImpl],
  );

  return { isPending, createCaseNote };
}
