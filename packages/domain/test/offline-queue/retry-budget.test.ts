import { describe, expect, it } from "vitest";

import {
  applyTransition,
  DEFAULT_BACKOFF_SCHEDULE_MS,
  DEFAULT_RETRY_MAX,
  isRetryBudgetExhausted,
  nextBackoffMs,
  RetryBudgetError,
} from "../../src/offline-queue/index.js";

// TR-OFFLINE-7a — pins the retry-count cap and the exponential-backoff
// schedule that consumers of @anthos/domain rely on. The backoff intervals
// are committed verbatim here so the curve remains auditable across spec
// revisions (ticket AC: "Backoff schedule is exponential; specific intervals
// committed in tests").

describe("isRetryBudgetExhausted", () => {
  it("progression 0..5 with default cap returns [false × 5, true]", () => {
    const results = [0, 1, 2, 3, 4, 5].map((count) =>
      isRetryBudgetExhausted(count),
    );
    expect(results).toEqual([false, false, false, false, false, true]);
  });

  it("default cap is 5 (matches DEFAULT_RETRY_MAX)", () => {
    expect(DEFAULT_RETRY_MAX).toBe(5);
    expect(isRetryBudgetExhausted(4)).toBe(false);
    expect(isRetryBudgetExhausted(5)).toBe(true);
  });

  it("honors a caller-supplied cap (NFR-MAINT-8)", () => {
    expect(isRetryBudgetExhausted(2, 3)).toBe(false);
    expect(isRetryBudgetExhausted(3, 3)).toBe(true);
    expect(isRetryBudgetExhausted(0, 1)).toBe(false);
    expect(isRetryBudgetExhausted(1, 1)).toBe(true);
  });

  it("returns true once past the cap (no clamp, no throw)", () => {
    expect(isRetryBudgetExhausted(99)).toBe(true);
  });

  it.each([-1, -100, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "throws RETRY_COUNT_NEGATIVE_OR_NAN on invalid currentRetryCount=%s",
    (bad) => {
      expect(() => isRetryBudgetExhausted(bad)).toThrowError(RetryBudgetError);
      try {
        isRetryBudgetExhausted(bad);
      } catch (err) {
        expect((err as RetryBudgetError).code).toBe(
          "RETRY_COUNT_NEGATIVE_OR_NAN",
        );
      }
    },
  );

  it.each([0, -1, 1.5, Number.NaN])(
    "throws MAX_RETRIES_INVALID on invalid maxRetries=%s",
    (bad) => {
      expect(() => isRetryBudgetExhausted(0, bad)).toThrowError(
        RetryBudgetError,
      );
      try {
        isRetryBudgetExhausted(0, bad);
      } catch (err) {
        expect((err as RetryBudgetError).code).toBe("MAX_RETRIES_INVALID");
      }
    },
  );
});

describe("nextBackoffMs — default schedule (auditable curve)", () => {
  it("default schedule is the TR-SMS-3 curve 5s → 15s → 45s → 2m → 5m", () => {
    expect(DEFAULT_BACKOFF_SCHEDULE_MS).toEqual([
      5_000,
      15_000,
      45_000,
      120_000,
      300_000,
    ]);
  });

  it.each([
    [1, 5_000],
    [2, 15_000],
    [3, 45_000],
    [4, 120_000],
    [5, 300_000],
  ])("nextBackoffMs(%d) → %dms", (retryNumber, expectedMs) => {
    expect(nextBackoffMs(retryNumber)).toBe(expectedMs);
  });

  it("default schedule length matches DEFAULT_RETRY_MAX", () => {
    expect(DEFAULT_BACKOFF_SCHEDULE_MS.length).toBe(DEFAULT_RETRY_MAX);
  });
});

describe("nextBackoffMs — exponential growth property", () => {
  // Geometric (~3×) growth with rounding to human-friendly intervals; TR-SMS-3
  // uses exactly this curve for Mogli SMS timeouts. The point of the test is
  // not the exact ratio but that each interval is strictly larger than the
  // previous one — i.e., the curve is monotonically increasing.
  it("each interval is strictly greater than the previous one", () => {
    for (let i = 1; i < DEFAULT_BACKOFF_SCHEDULE_MS.length; i++) {
      // eslint-disable-next-line security/detect-object-injection -- bounded loop index into readonly array
      const current = DEFAULT_BACKOFF_SCHEDULE_MS[i] as number;
      const prev = DEFAULT_BACKOFF_SCHEDULE_MS[i - 1] as number;
      expect(current).toBeGreaterThan(prev);
    }
  });
});

describe("nextBackoffMs — configurability (NFR-MAINT-8)", () => {
  it("accepts a custom schedule overriding the default", () => {
    const custom: ReadonlyArray<number> = [1_000, 2_000, 4_000];
    expect(nextBackoffMs(1, custom)).toBe(1_000);
    expect(nextBackoffMs(2, custom)).toBe(2_000);
    expect(nextBackoffMs(3, custom)).toBe(4_000);
  });

  it("throws BACKOFF_SCHEDULE_EMPTY when schedule is empty", () => {
    expect(() => nextBackoffMs(1, [])).toThrowError(RetryBudgetError);
    try {
      nextBackoffMs(1, []);
    } catch (err) {
      expect((err as RetryBudgetError).code).toBe("BACKOFF_SCHEDULE_EMPTY");
    }
  });

  it.each([0, -1, 6, 100, 1.5, Number.NaN])(
    "throws RETRY_NUMBER_OUT_OF_RANGE on upcomingRetryNumber=%s (default schedule has 5 entries)",
    (bad) => {
      expect(() => nextBackoffMs(bad)).toThrowError(RetryBudgetError);
      try {
        nextBackoffMs(bad);
      } catch (err) {
        expect((err as RetryBudgetError).code).toBe(
          "RETRY_NUMBER_OUT_OF_RANGE",
        );
      }
    },
  );

  it("throws RETRY_NUMBER_OUT_OF_RANGE when retry number exceeds custom schedule length", () => {
    expect(() => nextBackoffMs(4, [1_000, 2_000, 4_000])).toThrowError(
      RetryBudgetError,
    );
  });
});

describe("integration with applyTransition (P3C-08 wiring smoke test)", () => {
  // Exercise the contract documented at types.ts:39-41: the state machine
  // consumes whatever boolean P3C-09 hands it. This is intentionally narrow —
  // the full state-machine matrix is covered in transition.test.ts.
  it("currentRetryCount=4 → applyTransition increments and stays pending_sync", () => {
    const result = applyTransition("in_flight", {
      kind: "attempt_failed_transient",
      retryBudgetExhausted: isRetryBudgetExhausted(4),
    });
    expect(result.nextStatus).toBe("pending_sync");
    expect(result.retryCount).toBe("increment");
    expect(result.resolutionSource).toBe("auto_retry");
  });

  it("currentRetryCount=5 → applyTransition transitions to failed_max_retries", () => {
    const result = applyTransition("in_flight", {
      kind: "attempt_failed_transient",
      retryBudgetExhausted: isRetryBudgetExhausted(5),
    });
    expect(result.nextStatus).toBe("failed_max_retries");
    expect(result.retryCount).toBe("noop");
    expect(result.resolutionSource).toBe("auto_max_retries");
  });

  it("lock-row failure variant honors the same predicate", () => {
    const result = applyTransition("in_flight", {
      kind: "attempt_failed_lock_row",
      retryBudgetExhausted: isRetryBudgetExhausted(5),
    });
    expect(result.nextStatus).toBe("failed_max_retries");
    expect(result.resolutionSource).toBe("auto_max_retries");
  });
});

describe("purity", () => {
  // Mirrors the transition.test.ts purity convention: repeated calls with the
  // same inputs must produce structurally identical outputs.
  it("isRetryBudgetExhausted is referentially transparent across 50 invocations", () => {
    const baseline = isRetryBudgetExhausted(3);
    for (let i = 0; i < 50; i++) {
      expect(isRetryBudgetExhausted(3)).toBe(baseline);
    }
  });

  it("nextBackoffMs is referentially transparent across 50 invocations", () => {
    const baseline = nextBackoffMs(2);
    for (let i = 0; i < 50; i++) {
      expect(nextBackoffMs(2)).toBe(baseline);
    }
  });
});
