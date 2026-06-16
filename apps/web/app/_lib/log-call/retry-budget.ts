// Retry policy for the Pattern A reconcile loop. The ticket calls for "1–2
// retries with short backoff" — long retries are the offline queue's job
// (Pattern C / F-14, separate sub-phase). Anything else is terminal.
//
// Codes from API §9 we'll retry: `SF_UPSTREAM_UNAVAILABLE` (503,
// `SalesforceErrorResponse` for transient SF faults) and `INTERNAL_ERROR`
// (500). Generic `HTTP_502/503/504` shapes from `sendMutation` (when the
// envelope was non-JSON) ride the same path — surfaced as `HTTP_<status>`
// codes. `NETWORK_ERROR` is intentionally NOT retried here: per Pattern A
// the offline branch flows into Pattern C, which this ticket explicitly
// defers — so NETWORK_ERROR is terminal failure with the user-facing copy
// ("Could not save — retry") until the queue lands.

import type { MutationFailure } from "../../caseload/_lib/send-mutation";

// 1 retry after the initial attempt = 2 attempts total (matches the ticket
// "1–2 retries" lower bound — favors the conservative end since the offline
// queue carries the long-tail).
export const MAX_RETRY_ATTEMPTS = 1;

// Short backoff: enough to ride a transient blip without burning the
// AC-30 ≤30s budget. The full retry path costs at most one backoff before
// terminal rollback.
export const RETRY_BACKOFF_MS = 200;

const RETRYABLE_CODES = new Set<string>([
  "SF_UPSTREAM_UNAVAILABLE",
  "INTERNAL_ERROR",
  "HTTP_500",
  "HTTP_502",
  "HTTP_503",
  "HTTP_504",
]);

export function isRetryable(failure: MutationFailure): boolean {
  return RETRYABLE_CODES.has(failure.code);
}

// Pure decision: given a failure and which attempt just failed (0-indexed),
// should we retry? Used by the reconciler so the loop is testable without
// driving a real timer.
export function shouldRetry(failure: MutationFailure, attempt: number): boolean {
  if (attempt >= MAX_RETRY_ATTEMPTS) return false;
  return isRetryable(failure);
}

// Injection seam so tests don't depend on real wall time.
export type SleepFn = (ms: number) => Promise<void>;

export const defaultSleep: SleepFn = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));
