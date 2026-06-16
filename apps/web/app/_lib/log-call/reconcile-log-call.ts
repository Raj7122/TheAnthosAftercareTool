// Pure Pattern A orchestrator for F-08 Log-a-Call. Extracted from
// `use-log-call-reconciler.ts` so the optimistic-insert → submit → reconcile
// → retry → rollback loop is testable without React. The hook is a thin
// wrapper that resolves the dispatch from context and forwards to here.
//
// All deps (dispatch, mutation, sleep, clock, id generator) are passed in.
// This makes the test surface a single value-in/value-out function and
// matches the repo's `submitLogCall` precedent.

import type { LogCallResponseBody } from "@anthos/api";

import type { MutationFailure } from "../../caseload/_lib/send-mutation";
import type {
  LogCallInput,
  LogCallResult,
} from "../../caseload/_lib/useLogCallMutation";

import { buildOptimisticCaseNote } from "../case-notes/build-optimistic";
import type { OptimisticCaseNote } from "../case-notes/types";

import {
  MAX_RETRY_ATTEMPTS,
  RETRY_BACKOFF_MS,
  shouldRetry,
  type SleepFn,
} from "./retry-budget";

// Subset of the dispatch surface this loop needs. The full context dispatch
// is a superset and assignment-compatible.
export interface ReconcileDispatch {
  readonly insertOptimistic: (optimistic: OptimisticCaseNote) => void;
  readonly replaceWithCanonical: (
    optimisticId: string,
    canonical: LogCallResponseBody,
    traceId: string | null,
  ) => void;
  readonly rollback: (participantId: string, optimisticId: string) => void;
}

export type LogCallMutationFn = (
  participantId: string,
  idempotencyKey: string,
  input: LogCallInput,
) => Promise<LogCallResult>;

export interface ReconcileLogCallDeps {
  readonly dispatch: ReconcileDispatch;
  readonly logCall: LogCallMutationFn;
  readonly sleep: SleepFn;
  readonly now: () => Date;
  readonly newOptimisticId: () => string;
}

// Returns `null` on success, the structured terminal failure on rollback.
// The same `idempotencyKey` is reused across retries — Pattern D dedupe on
// the BFF side guarantees a `COMPLETED` replay returns the stored 2xx.
export async function reconcileLogCall(
  deps: ReconcileLogCallDeps,
  participantId: string,
  idempotencyKey: string,
  input: LogCallInput,
): Promise<MutationFailure | null> {
  const optimisticId = deps.newOptimisticId();
  const optimistic = buildOptimisticCaseNote({
    participantId,
    optimisticId,
    callStatus: input.status,
    type: input.type,
    serviceDate: input.serviceDate,
    summary:
      input.summary !== undefined && input.summary.length > 0
        ? input.summary
        : null,
    now: deps.now,
  });

  // UI updates now (Pattern A: "apply_to_local_store(optimistic_record)").
  deps.dispatch.insertOptimistic(optimistic);
  // P1F-06 — per-stage perf marks. Guarded so a non-browser execution
  // (unit tests run via vitest under node) silently skips them. The marks
  // bracket the network round-trip on each attempt; `performance.mark`
  // APPENDS entries under the same name (it does not overwrite), so a
  // retry path produces multiple `network:start` / `network:end` entries.
  // The perf-test reader (`readStagesFromPage`) selects the last entry
  // per name, so the observed network span reflects the final attempt —
  // adequate for AC-30 median measurement (the test submits a known-good
  // payload that doesn't hit the retry path).
  markIfAvailable("logcall:optimistic:applied");

  let lastFailure: MutationFailure | null = null;
  for (let attempt = 0; attempt <= MAX_RETRY_ATTEMPTS; attempt += 1) {
    markIfAvailable("logcall:network:start");
    const result = await deps.logCall(participantId, idempotencyKey, input);
    markIfAvailable("logcall:network:end");
    if (result.outcome === "success") {
      // Canonical record replaces the optimistic; trace_id matches the
      // BFF's pre-response Pattern B `call.logged` SUCCESS row.
      deps.dispatch.replaceWithCanonical(
        optimisticId,
        result.body,
        result.traceId,
      );
      markIfAvailable("logcall:reconciled");
      return null;
    }
    lastFailure = result.failure;
    if (!shouldRetry(result.failure, attempt)) break;
    await deps.sleep(RETRY_BACKOFF_MS);
  }

  // Terminal failure — visible rollback (Pattern A "Don't roll back
  // silently"; the sheet's banner carries the structured error).
  deps.dispatch.rollback(participantId, optimisticId);
  return lastFailure;
}

// P1F-06 — `globalThis.performance` is present in browsers and Node 16+,
// but `performance.mark` is a no-op-friendly seam. The guard exists for
// the same reason the vitest path skips: pure-node consumers of this
// orchestrator should not observe a side effect from a perf hook.
function markIfAvailable(name: string): void {
  const perf = (globalThis as { performance?: { mark?: (name: string) => void } }).performance;
  perf?.mark?.(name);
}
