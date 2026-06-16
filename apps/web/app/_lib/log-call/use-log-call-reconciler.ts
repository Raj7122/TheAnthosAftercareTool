"use client";

// P1F-05 — React glue for the Pattern A reconcile loop. Resolves the
// recent-case-notes dispatch from context, wires up the mutation primitive
// and the default sleep/clock/id seams, and delegates to the pure
// `reconcileLogCall` orchestrator (which is what the tests drive).
//
// Architecture posture: P1F-08 (the F-07 detail page SPA shell) has not
// landed yet, so the only mounted consumer of the recent-case-notes store
// today is whichever surface launches the LogCallSheet. The reconciler runs
// anyway — optimistic + canonical records sit in the store regardless of
// whether a timeline renders against them; when P1F-08 mounts a consumer
// against `useRecentCaseNotes(participantId)`, the same records appear
// without changing this hook.
//
// Audit: NO client-side audit row is emitted. The BFF writes a Pattern B
// `call.logged` row BEFORE the response on every reachable outcome (SUCCESS
// on 2xx — create-call.ts:557; FAILED on authz/SF errors —
// create-call.ts:395/465). The DoD line "matched to the server-side
// trace_id" is satisfied by propagating `X-Trace-Id` onto the
// `LocalCaseNote` (state: 'confirmed'.traceId) so the SPA's reconcile is
// correlatable to the server-side audit row. Inventing a second
// post-response audit row would violate Pattern B's "BEFORE-response"
// invariant and duplicate state outside the canonical ledger — surfaced in
// PR body per the "patterns beat ticket" precedence rule.

import { useCallback, useRef } from "react";

import {
  useLogCallMutation,
  type LogCallInput,
} from "../../caseload/_lib/useLogCallMutation";
import type {
  FetchLike,
  MutationFailure,
} from "../../caseload/_lib/send-mutation";

import { useRecentCaseNotesDispatch } from "../case-notes/context";
import { enqueue, remove } from "../offline/outbox";
import { isTopLevelOriginSurface } from "../offline/pwa-surface";
import { flashSynced } from "../offline/replay";

import {
  reconcileLogCall,
  type ReconcileLogCallDeps,
} from "./reconcile-log-call";
import { reconcileWithOutboxMirror } from "./with-outbox-mirror";
import { defaultSleep, type SleepFn } from "./retry-budget";

export interface UseLogCallReconcilerOptions {
  // Defaults to a `() => fetch(...)` global — same shape `useLogCallMutation`
  // already accepts. Tests override.
  readonly fetchImpl?: FetchLike;
  // Optimistic-id generator. Defaults to a `crypto.randomUUID()`-backed
  // helper; tests inject a deterministic counter.
  readonly newOptimisticId?: () => string;
  // Server clock seam — stamps `optimisticAt` on the local record. The
  // server's `loggedAt` is authoritative on the canonical record; this only
  // exists for pre-reconcile timeline ordering.
  readonly now?: () => Date;
  // Sleep seam for the 5xx retry backoff — tests pass a 0-ms or fake-timer
  // implementation.
  readonly sleep?: SleepFn;
  // P3C-13 — Outbox mirror toggle (Pattern C/D). Defaults to the tablet PWA
  // surface (`isTopLevelOriginSurface()`): only there do `useOutbox()` and
  // `replayOutbox()` exist to render + drain the mirror. On the desktop
  // iframe surface the mirror is off (its reconnect path is /healthz +
  // `SyncOnReconnect`, not the page-side Outbox), so submits don't leave
  // orphan IndexedDB rows. Tests force the boolean.
  readonly outboxMirror?: boolean;
}

export interface UseLogCallReconcilerResult {
  // Returns `null` on success, the structured failure on terminal rollback.
  // The sheet renders the failure inline (banner / field-mapped) and stays
  // open so the specialist can retry — the same idempotency key is reused
  // and Pattern D dedupes server-side.
  readonly reconcileLogCall: (
    participantId: string,
    idempotencyKey: string,
    input: LogCallInput,
  ) => Promise<MutationFailure | null>;
}

export function useLogCallReconciler(
  options: UseLogCallReconcilerOptions = {},
): UseLogCallReconcilerResult {
  const { logCall } = useLogCallMutation(
    options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {},
  );
  const dispatch = useRecentCaseNotesDispatch();

  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? (() => new Date());
  const newOptimisticId = options.newOptimisticId ?? defaultOptimisticId;

  // Stash the latest deps on a ref so the returned callback identity is
  // stable across renders (sheets pass it to child components that memo on
  // callback identity).
  const depsRef = useRef<ReconcileLogCallDeps>({
    dispatch,
    logCall,
    sleep,
    now,
    newOptimisticId,
  });
  depsRef.current = { dispatch, logCall, sleep, now, newOptimisticId };

  // Resolve the mirror toggle once per render; default to the tablet surface.
  const mirrorEnabled =
    options.outboxMirror ?? isTopLevelOriginSurface();
  const mirrorRef = useRef<boolean>(mirrorEnabled);
  mirrorRef.current = mirrorEnabled;

  const reconcile = useCallback<
    UseLogCallReconcilerResult["reconcileLogCall"]
  >((participantId, idempotencyKey, input) => {
    const runReconcile = (
      pid: string,
      key: string,
      logCallInput: LogCallInput,
    ): Promise<MutationFailure | null> =>
      reconcileLogCall(depsRef.current, pid, key, logCallInput);

    if (!mirrorRef.current) {
      return runReconcile(participantId, idempotencyKey, input);
    }
    return reconcileWithOutboxMirror(
      {
        enqueue,
        markSynced: (row) => flashSynced(row),
        discard: remove,
        reconcile: runReconcile,
      },
      participantId,
      idempotencyKey,
      input,
    );
  }, []);

  return { reconcileLogCall: reconcile };
}

// Default optimistic-id generator. `crypto.randomUUID()` is on `globalThis`
// in modern browsers and Node 19+ — the load-bearing path. The fallback
// (counter+timestamp) is defensive against ancient browsers we don't
// realistically expect; the counter is encapsulated in an IIFE closure so
// it doesn't leak as module-level mutable state.
const defaultOptimisticId: () => string = (() => {
  let fallbackCounter = 0;
  return function defaultOptimisticIdInner(): string {
    const c = globalThis.crypto as Crypto | undefined;
    if (c !== undefined && typeof c.randomUUID === "function") {
      return `optimistic:${c.randomUUID()}`;
    }
    fallbackCounter += 1;
    return `optimistic:${Date.now()}-${fallbackCounter}`;
  };
})();
