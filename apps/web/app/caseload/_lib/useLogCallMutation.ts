"use client";

// F-08 Log-a-Call submit hook. Dedicated (not folded into
// `useCaseloadMutations`) because P1F-04 explicitly defers optimistic-UI
// reconciliation to P1F-05 — `useCaseloadMutations` is tightly coupled to the
// F-06 snapshot/rollback overlay, and shoe-horning a third method that opts
// out of optimism would dilute the hook's concept. When P1F-05 lands, the
// `LogCallResponseBody.priorityRecomputed` carried back here is the seam it
// hooks into.
//
// Idempotency-Key is NOT minted here — the sheet's parent owns the
// key-at-open lifecycle (Pattern D, ticket §AC: "generated at sheet-open
// time and reused across in-sheet retries"). The hook receives the key as a
// parameter so multiple Submit clicks within an open sheet land on the same
// idempotency row at the BFF.

import { useCallback } from "react";

import type { LogCallResponseBody, LogCallStatus, LogCallType } from "@anthos/api";

import {
  sendMutation,
  type FetchLike,
  type MutationFailure,
} from "./send-mutation";

export interface LogCallInput {
  readonly status: LogCallStatus;
  readonly type: LogCallType;
  // YYYY-MM-DD per E-10 `serviceDate` shape. The window check
  // (≥ today-14d, ≤ today+1d) runs on the server against the resolved clock;
  // the sheet also enforces it client-side for instant feedback.
  readonly serviceDate: string;
  // Omitted entirely when empty (avoids sending `"summary": ""` which would
  // round-trip a meaningless key — the schema treats undefined and missing
  // identically, and server enforces VR-18 on Completed regardless).
  readonly summary?: string;
}

export type LogCallResult =
  | {
      readonly outcome: "success";
      readonly body: LogCallResponseBody;
      // P1F-05: `X-Trace-Id` from the 2xx response. Propagated onto the
      // local `LocalCaseNote` (state: 'confirmed') so the SPA's reconcile
      // correlates to the BFF's pre-response Pattern B audit row. `null`
      // when the response omitted the header (shouldn't happen — E-10's
      // `responses.ts` always sets it — but typed defensively).
      readonly traceId: string | null;
    }
  | { readonly outcome: "failure"; readonly failure: MutationFailure };

export interface UseLogCallMutationOptions {
  readonly fetchImpl?: FetchLike;
}

export interface UseLogCallMutationResult {
  readonly logCall: (
    participantId: string,
    idempotencyKey: string,
    input: LogCallInput,
  ) => Promise<LogCallResult>;
}

const globalFetch: FetchLike = (...args) => fetch(...args);

export function useLogCallMutation(
  options?: UseLogCallMutationOptions,
): UseLogCallMutationResult {
  const fetchImpl = options?.fetchImpl ?? globalFetch;

  const logCall = useCallback<UseLogCallMutationResult["logCall"]>(
    (participantId, idempotencyKey, input) =>
      submitLogCall(fetchImpl, participantId, idempotencyKey, input),
    [fetchImpl],
  );

  return { logCall };
}

// Pure submit helper. Extracted from the hook so the request-shaping +
// envelope-mapping path can be unit-tested without rendering React (the
// apps/web tests don't bring in `@testing-library/react`). The hook is a
// thin `useCallback` wrapper over this.
export async function submitLogCall(
  fetchImpl: FetchLike,
  participantId: string,
  idempotencyKey: string,
  input: LogCallInput,
): Promise<LogCallResult> {
  const body: LogCallRequestBody = {
    status: input.status,
    type: input.type,
    serviceDate: input.serviceDate,
  };
  if (input.summary !== undefined && input.summary.length > 0) {
    body.summary = input.summary;
  }

  const result = await sendMutation(fetchImpl, {
    method: "POST",
    url: `/api/v1/participants/${encodeURIComponent(participantId)}/calls`,
    idempotencyKey,
    body,
  });

  if (result.kind === "failure") {
    return { outcome: "failure", failure: result.failure };
  }
  return {
    outcome: "success",
    body: result.body as LogCallResponseBody,
    traceId: result.traceId,
  };
}

interface LogCallRequestBody {
  status: LogCallStatus;
  type: LogCallType;
  serviceDate: string;
  summary?: string;
}
