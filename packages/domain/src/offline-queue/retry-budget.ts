// TR-OFFLINE-7a / Pattern C — Retry budget pure functions.
//
// The Review Required state machine (transition.ts) intentionally delegates
// the exhaustion decision to its caller (see types.ts:39-41). This module
// supplies that decision plus the exponential-backoff schedule the sync
// worker (P3C-06 follow-up at post-queue-sync.ts:187-195) needs to time
// each retry.
//
// Defaults reuse the only explicit exponential schedule in the TRD —
// TR-SMS-3 (Mogli SMS): 5s → 15s → 45s → 2m → 5m, max 5 attempts. Schedules
// are configuration per NFR-MAINT-8, so the worker may override at the call
// site without re-implementing the curve.
//
// Counting semantics (worked example with the default cap of 5):
//
//   Attempt | retry_count BEFORE | isRetryBudgetExhausted | Outcome     | retry_count AFTER
//   1 init  | 0                  | false                  | increment   | 1
//   2 r1    | 1                  | false                  | increment   | 2
//   3 r2    | 2                  | false                  | increment   | 3
//   4 r3    | 3                  | false                  | increment   | 4
//   5 r4    | 4                  | false                  | increment   | 5
//   6 r5    | 5                  | TRUE                   | dead-letter | (noop)
//
// Six total attempts, five retries, dead-letter on the sixth failed attempt.
// Matches TR-OFFLINE-7a verbatim and pattern-c-offline-queue.md:44-46.

export const DEFAULT_RETRY_MAX = 5;

export const DEFAULT_BACKOFF_SCHEDULE_MS: ReadonlyArray<number> = Object.freeze(
  [
    5_000, // retry 1: 5s
    15_000, // retry 2: 15s
    45_000, // retry 3: 45s
    120_000, // retry 4: 2m
    300_000, // retry 5: 5m
  ],
);

// Fail-loud invariant errors. Negative counts, NaN, and out-of-range retry
// numbers are programmer bugs in the caller, not runtime conditions the
// worker can recover from — mirror the InvalidTransitionError idiom.
export class RetryBudgetError extends Error {
  override readonly name = "RetryBudgetError";
  readonly code:
    | "RETRY_COUNT_NEGATIVE_OR_NAN"
    | "MAX_RETRIES_INVALID"
    | "RETRY_NUMBER_OUT_OF_RANGE"
    | "BACKOFF_SCHEDULE_EMPTY";

  constructor(code: RetryBudgetError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

// True when `offline_queue.retry_count` has reached the cap. Pass the column
// value directly (NOT pre-incremented) — applyTransition's
// attempt_failed_transient / attempt_failed_lock_row branches consume the
// boolean and either return retryCount='increment' (next attempt) or
// nextStatus='failed_max_retries' (dead-letter).
export function isRetryBudgetExhausted(
  currentRetryCount: number,
  maxRetries: number = DEFAULT_RETRY_MAX,
): boolean {
  if (!Number.isInteger(currentRetryCount) || currentRetryCount < 0) {
    throw new RetryBudgetError(
      "RETRY_COUNT_NEGATIVE_OR_NAN",
      `currentRetryCount must be a non-negative integer, got ${String(currentRetryCount)}`,
    );
  }
  if (!Number.isInteger(maxRetries) || maxRetries < 1) {
    throw new RetryBudgetError(
      "MAX_RETRIES_INVALID",
      `maxRetries must be a positive integer, got ${String(maxRetries)}`,
    );
  }
  return currentRetryCount >= maxRetries;
}

// Milliseconds to wait before the next retry attempt. `upcomingRetryNumber`
// is 1-indexed: 1 = first retry (after the initial attempt failed), 5 = last
// retry under the default cap. Caller flow after applyTransition returns
// retryCount='increment':
//   const newCount = item.retryCount + 1;
//   const delayMs = nextBackoffMs(newCount);
//   await scheduleAt(now + delayMs);
export function nextBackoffMs(
  upcomingRetryNumber: number,
  schedule: ReadonlyArray<number> = DEFAULT_BACKOFF_SCHEDULE_MS,
): number {
  if (schedule.length === 0) {
    throw new RetryBudgetError(
      "BACKOFF_SCHEDULE_EMPTY",
      "backoff schedule must contain at least one delay",
    );
  }
  if (
    !Number.isInteger(upcomingRetryNumber) ||
    upcomingRetryNumber < 1 ||
    upcomingRetryNumber > schedule.length
  ) {
    throw new RetryBudgetError(
      "RETRY_NUMBER_OUT_OF_RANGE",
      `upcomingRetryNumber must be an integer in [1, ${schedule.length}], got ${String(upcomingRetryNumber)}`,
    );
  }
  return schedule[upcomingRetryNumber - 1] as number;
}
