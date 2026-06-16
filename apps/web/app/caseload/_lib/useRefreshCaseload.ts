"use client";

// F-16 hard-refresh client hook. Owns the button state machine
// (idle | pending | rateLimited | error), the Retry-After countdown, and
// the diff computation between the pre-refresh and post-refresh
// CaseloadBody. The parent (CaseloadView) consumes `onRefreshed` to swap
// in the new body and surface the changed-row set.
//
// Idempotency-Key (Immutable #6 / Pattern D) is generated per click via
// `newIdempotencyKey()`. A second click while a request is in flight is
// rejected at the hook boundary (pending guard) — so the wire-level key
// dedupes the transport-layer retry case (network blip), and the UI guard
// dedupes the rapid-double-tap case.

import { useCallback, useEffect, useRef, useState } from "react";

import type { CaseloadBody, CaseloadItem } from "@anthos/api";
import { newIdempotencyKey } from "@anthos/domain";

import { computeDiff } from "./diff-caseload";
import {
  postRefreshCaseload,
  type RefreshOutcome,
} from "./refresh-request";
import type { FetchLike, MutationFailure } from "./send-mutation";

export type RefreshState = "idle" | "pending" | "rateLimited" | "error";

export interface UseRefreshCaseloadOptions {
  // Snapshot the hook diffs against. The parent passes the currently-rendered
  // items so a successful refresh can compute the changed-id set.
  readonly currentItems: ReadonlyArray<CaseloadItem>;
  readonly onRefreshed: (input: {
    readonly body: CaseloadBody;
    readonly changedIds: ReadonlySet<string>;
  }) => void;
  // Test seams.
  readonly fetchImpl?: FetchLike;
  readonly idempotencyKeyFactory?: () => string;
  // 1-Hz timer seam — defaults to `setInterval`/`clearInterval`.
  readonly setIntervalImpl?: typeof setInterval;
  readonly clearIntervalImpl?: typeof clearInterval;
}

export interface UseRefreshCaseloadResult {
  readonly state: RefreshState;
  readonly retryAfterSeconds: number;
  readonly error: MutationFailure | null;
  readonly refresh: () => Promise<void>;
}

export function useRefreshCaseload(
  options: UseRefreshCaseloadOptions,
): UseRefreshCaseloadResult {
  const [state, setState] = useState<RefreshState>("idle");
  const [retryAfterSeconds, setRetryAfterSeconds] = useState(0);
  const [error, setError] = useState<MutationFailure | null>(null);

  const fetchImpl = options.fetchImpl ?? globalFetch;
  const keyFactory = options.idempotencyKeyFactory ?? newIdempotencyKey;
  const setIntervalFn = options.setIntervalImpl ?? setInterval;
  const clearIntervalFn = options.clearIntervalImpl ?? clearInterval;

  // The pending-state guard against rapid double-clicks. A ref (not just
  // state) so a synchronous re-entry inside the same tick is rejected
  // BEFORE setState batching can flip `state`.
  const inFlightRef = useRef(false);

  // Keep the latest items in a ref so a long-running refresh diffs against
  // the items at REQUEST TIME, not whatever the parent re-rendered with
  // in between. The Pattern A optimistic-UI hook follows the same pattern.
  const itemsRef = useRef<ReadonlyArray<CaseloadItem>>(options.currentItems);
  useEffect(() => {
    itemsRef.current = options.currentItems;
  }, [options.currentItems]);

  // 1-Hz countdown driven by `Retry-After`. Cleared on unmount, on
  // re-entering pending, and on hitting 0 — at which point the hook
  // returns to idle so the user can retry.
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stopCountdown = useCallback(() => {
    if (countdownRef.current !== null) {
      clearIntervalFn(countdownRef.current);
      countdownRef.current = null;
    }
  }, [clearIntervalFn]);
  useEffect(() => stopCountdown, [stopCountdown]);

  const startCountdown = useCallback(
    (seconds: number) => {
      stopCountdown();
      setRetryAfterSeconds(seconds);
      countdownRef.current = setIntervalFn(() => {
        setRetryAfterSeconds((prev) => {
          const next = prev - 1;
          if (next <= 0) {
            stopCountdown();
            setState("idle");
            return 0;
          }
          return next;
        });
      }, 1000);
    },
    [setIntervalFn, stopCountdown],
  );

  const onRefreshedRef = useRef(options.onRefreshed);
  useEffect(() => {
    onRefreshedRef.current = options.onRefreshed;
  }, [options.onRefreshed]);

  const refresh = useCallback(async () => {
    if (inFlightRef.current) return;
    if (state === "rateLimited") return;
    inFlightRef.current = true;
    stopCountdown();
    setRetryAfterSeconds(0);
    setError(null);
    setState("pending");

    const snapshot = itemsRef.current;
    let outcome: RefreshOutcome;
    try {
      outcome = await postRefreshCaseload(fetchImpl, keyFactory());
    } finally {
      inFlightRef.current = false;
    }

    if (outcome.kind === "success") {
      const changedIds = computeDiff(snapshot, outcome.body.items);
      onRefreshedRef.current({ body: outcome.body, changedIds });
      setState("idle");
      return;
    }
    if (outcome.kind === "rate_limited") {
      setError(outcome.failure);
      setState("rateLimited");
      startCountdown(outcome.retryAfterSeconds);
      return;
    }
    setError(outcome.failure);
    setState("error");
  }, [fetchImpl, keyFactory, startCountdown, state, stopCountdown]);

  return { state, retryAfterSeconds, error, refresh };
}

const globalFetch: FetchLike = (input, init) =>
  fetch(input as RequestInfo, init);
