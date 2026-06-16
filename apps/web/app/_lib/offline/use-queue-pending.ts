"use client";

// P3C-12 — hook backing the F-14 offline-queue indicator and inspector.
//
// Wires the three refresh triggers the ticket calls "sensible": on mount,
// on `visibilitychange → visible` (tab/window focus), and immediately
// after each successful `POST /queue/:id/resolve`. No polling — items
// stay quiet between user-initiated focus events.
//
// `status` carries the four authentication outcomes the client cares
// about distinctly: `unauthenticated` (401), `forbidden` (403),
// `ready` (200), and `error` (4xx/5xx/network). The indicator hides on
// the first two so non-SPECIALIST or signed-out paths show no chip.

import { useCallback, useEffect, useRef, useState } from "react";

import type {
  QueuePendingBody,
  QueuePendingItem,
  QueueResolveRequest,
} from "@anthos/api";

import {
  fetchQueuePending,
  postQueueResolve,
  type FetchLike,
  type ResolveOutcome,
} from "./queue-pending-client";

export type UseQueuePendingStatus =
  | "loading"
  | "ready"
  | "unauthenticated"
  | "forbidden"
  | "error";

export interface UseQueuePendingOptions {
  // Injectable for tests. Defaults to `globalThis.fetch`.
  readonly fetchImpl?: FetchLike;
  // Injectable for tests. Defaults to `crypto.randomUUID()` with a
  // best-effort fallback for environments that lack it.
  readonly mintIdempotencyKey?: () => string;
}

export interface UseQueuePendingResult {
  readonly items: ReadonlyArray<QueuePendingItem>;
  // `queueDepth` from the wire envelope — authoritative total. The
  // returned `items` are capped at `maxQueueDepth` (100) per the
  // §7.5.1 contract, so on a saturated queue `count > items.length`.
  readonly count: number;
  readonly status: UseQueuePendingStatus;
  readonly error: string | null;
  readonly refresh: () => Promise<void>;
  readonly resolve: (input: {
    readonly queueItemId: string;
    readonly request: QueueResolveRequest;
  }) => Promise<ResolveOutcome>;
}

export function useQueuePending(
  options: UseQueuePendingOptions = {},
): UseQueuePendingResult {
  const fetchImpl = options.fetchImpl ?? defaultFetch;
  const mintKey = options.mintIdempotencyKey ?? defaultMintKey;

  const [body, setBody] = useState<QueuePendingBody | null>(null);
  const [status, setStatus] = useState<UseQueuePendingStatus>("loading");
  const [error, setError] = useState<string | null>(null);

  const mountedRef = useRef(true);

  const performFetch = useCallback(async () => {
    const outcome = await fetchQueuePending(fetchImpl);
    if (!mountedRef.current) return;
    switch (outcome.kind) {
      case "success":
        setBody(outcome.body);
        setStatus("ready");
        setError(null);
        return;
      case "unauthenticated":
        setBody(null);
        setStatus("unauthenticated");
        setError(null);
        return;
      case "forbidden":
        setBody(null);
        setStatus("forbidden");
        setError(null);
        return;
      case "failure":
        setStatus("error");
        setError(outcome.failure.message);
        return;
    }
  }, [fetchImpl]);

  useEffect(() => {
    mountedRef.current = true;
    void performFetch();
    const onVisibility = (): void => {
      if (document.visibilityState === "visible") {
        void performFetch();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      mountedRef.current = false;
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [performFetch]);

  const resolve = useCallback(
    async (input: {
      readonly queueItemId: string;
      readonly request: QueueResolveRequest;
    }): Promise<ResolveOutcome> => {
      const outcome = await postQueueResolve(fetchImpl, {
        queueItemId: input.queueItemId,
        idempotencyKey: mintKey(),
        request: input.request,
      });
      if (outcome.kind === "success") {
        await performFetch();
      }
      return outcome;
    },
    [fetchImpl, mintKey, performFetch],
  );

  return {
    items: body?.items ?? [],
    count: body?.queueDepth ?? 0,
    status,
    error,
    refresh: performFetch,
    resolve,
  };
}

function defaultFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  return globalThis.fetch(input, init);
}

function defaultMintKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
