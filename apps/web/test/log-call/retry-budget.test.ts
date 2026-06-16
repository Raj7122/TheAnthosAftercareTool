import { describe, expect, it } from "vitest";

import {
  isRetryable,
  MAX_RETRY_ATTEMPTS,
  shouldRetry,
} from "../../app/_lib/log-call/retry-budget";
import type { MutationFailure } from "../../app/caseload/_lib/send-mutation";

function failure(code: string): MutationFailure {
  return {
    code,
    message: "test failure",
    traceId: "t-1",
    field: null,
    reason: null,
  };
}

describe("isRetryable", () => {
  it("retries on SF transient codes (SF_UPSTREAM_UNAVAILABLE)", () => {
    expect(isRetryable(failure("SF_UPSTREAM_UNAVAILABLE"))).toBe(true);
  });

  it("retries on INTERNAL_ERROR (500)", () => {
    expect(isRetryable(failure("INTERNAL_ERROR"))).toBe(true);
  });

  it("retries on generic HTTP_5xx envelopes from sendMutation fallback", () => {
    expect(isRetryable(failure("HTTP_500"))).toBe(true);
    expect(isRetryable(failure("HTTP_502"))).toBe(true);
    expect(isRetryable(failure("HTTP_503"))).toBe(true);
    expect(isRetryable(failure("HTTP_504"))).toBe(true);
  });

  it("does NOT retry on 4xx terminal codes", () => {
    expect(isRetryable(failure("VALIDATION_FAILED"))).toBe(false);
    expect(isRetryable(failure("SUMMARY_REQUIRED_FOR_COMPLETED"))).toBe(false);
    expect(isRetryable(failure("NOT_IN_OWN_CASELOAD"))).toBe(false);
    expect(isRetryable(failure("RESOURCE_NOT_FOUND"))).toBe(false);
    expect(isRetryable(failure("ROLE_INSUFFICIENT_SCOPE"))).toBe(false);
  });

  it("does NOT retry on Pattern D idempotency conflict codes (real §9.2 catalog)", () => {
    // 409 from `withIdempotency` middleware — same key already in flight on
    // the BFF. Retrying with the same key would just hit the same in-flight
    // state; the right user move is to wait or open a fresh sheet.
    expect(isRetryable(failure("IDEMPOTENCY_IN_FLIGHT"))).toBe(false);
    // 422 from `withIdempotency` — caller reused a key with a different
    // payload (caller-side bug). Retrying would change nothing.
    expect(
      isRetryable(failure("IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD")),
    ).toBe(false);
  });

  it("does NOT retry on NETWORK_ERROR (Pattern C territory — out of scope for P1F-05)", () => {
    expect(isRetryable(failure("NETWORK_ERROR"))).toBe(false);
  });
});

describe("shouldRetry", () => {
  it("retries a 5xx on attempt 0 (the initial attempt)", () => {
    expect(shouldRetry(failure("SF_UPSTREAM_UNAVAILABLE"), 0)).toBe(true);
  });

  it("does not retry once attempt count reaches MAX_RETRY_ATTEMPTS", () => {
    expect(
      shouldRetry(failure("SF_UPSTREAM_UNAVAILABLE"), MAX_RETRY_ATTEMPTS),
    ).toBe(false);
  });

  it("does not retry a 4xx even on attempt 0", () => {
    expect(shouldRetry(failure("VALIDATION_FAILED"), 0)).toBe(false);
  });

  it("enforces the budget of at-most-1 retry (2 attempts total)", () => {
    // attempt 0: shouldRetry → true → trigger 1 retry (attempt 1)
    // attempt 1: shouldRetry → false (budget exhausted)
    expect(shouldRetry(failure("SF_UPSTREAM_UNAVAILABLE"), 0)).toBe(true);
    expect(shouldRetry(failure("SF_UPSTREAM_UNAVAILABLE"), 1)).toBe(false);
  });
});
