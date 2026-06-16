"use client";

// P3C-11 — AC-52 sync-SLA trigger for the desktop Salesforce-iframe surface
// (ADR-05 fallback branch per SAD v1.2 §6.5b).
//
// Spec note. FS v1.14 §F-14 line 1161 + TRD v1.9 TR-OFFLINE-2/7b + SAD v1.2
// §6.5b explicitly carve AC-50..AC-57 out of scope on this surface: "no
// client-side queue exists on this surface." This component implements the
// ticket's "both paths wire reconnect-detection into sync trigger" language
// per an explicit user decision to follow the ticket over the spec narrowing.
// The /queue/sync endpoint drains the server-side `offline_queue` (Pattern C
// items the BFF enqueued when Salesforce was down) rather than any client-
// side queue — there is no IndexedDB Outbox on this surface. The PR for this
// ticket must flag the divergence so the next FS / TRD / SAD pass either
// amends to cover both surfaces, or this trigger is reverted.
//
// On the tablet PWA surface (`isTopLevelOriginSurface() === true`),
// `ConnectivityProvider` pins state to "online" forever, so this component
// is mounted but inert there — the state-transition predicate below never
// matches. The tablet's AC-52 trigger is Serwist's `BackgroundSyncPlugin`
// in `sw.ts`; observability for that path lives in `SyncObserver.tsx`.
//
// Behavior on the iframe surface:
//   1. Track `previous` connectivity state via `useRef` so a transition is
//      detectable across renders without re-firing on every render.
//   2. On `degraded → online` (only — the asymmetric recovery rule encoded
//      in `state-machine.ts` means this fires only after a successful
//      `/healthz` probe, not a flaky browser `online` event), fire one
//      `POST /api/v1/queue/sync` with a freshly-generated
//      `Idempotency-Key`. No client-side debounce — the server-side
//      anti-thrash rate limit (1/2s per specialist) catches repeats.
//   3. Emit a single `console.info("[anthos.sync_sla] ...")` line per
//      attempt with the HTTP outcome. PWABootstrap-style log shape so
//      Playwright `page.on("console")` can assert against it in E2E.
//
// Error policy. Every fetch outcome — 200, 429, 5xx, network failure,
// abort — yields exactly one log line. We never silently catch
// errors. 4xx (other than 429) and 5xx are logged as `server_error`
// with the status code; the client does not retry — the next
// `degraded → online` edge will retry.

import { useEffect, useRef } from "react";

import { newIdempotencyKey } from "@anthos/domain";

import { useConnectivity } from "../../_lib/connectivity/context";
import { isTopLevelOriginSurface } from "../../_lib/offline/pwa-surface";

type SyncOutcome =
  | "success"
  | "rate_limited"
  | "server_error"
  | "network_error"
  | "aborted";

interface TriggerFetch {
  (input: string, init: RequestInit): Promise<Response>;
}

interface Props {
  // Test seam — production callers omit this. When provided, the component
  // calls `fetchImpl` instead of `globalThis.fetch` so unit tests can drive
  // outcomes deterministically without spying on global fetch.
  readonly fetchImpl?: TriggerFetch;
  // Test seam — defaults to `Date.now`. Lets tests inject a deterministic
  // clock for the elapsed-ms field.
  readonly now?: () => number;
}

export function SyncOnReconnect({ fetchImpl, now = Date.now }: Props = {}) {
  const state = useConnectivity();
  const previousRef = useRef<typeof state | undefined>(undefined);
  const degradedSinceRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    // Cross-surface isolation. On the tablet PWA surface the connectivity
    // state is pinned to "online" forever, so this guard is belt-and-braces
    // — even if `useConnectivity()` ever started returning "degraded" on
    // that surface, the tablet's sync trigger is Serwist's
    // BackgroundSyncPlugin, not /queue/sync.
    if (isTopLevelOriginSurface()) {
      previousRef.current = state;
      return;
    }

    const prev = previousRef.current;
    previousRef.current = state;

    if (state === "degraded") {
      // Stamp T0 on the moment we entered degraded. Reused below when we
      // recover so the log carries `degraded_duration_ms` — useful for
      // distinguishing "real outage" recoveries from heartbeat blips.
      if (prev !== "degraded") {
        degradedSinceRef.current = now();
      }
      return;
    }

    // state === "online" path.
    if (prev !== "degraded") {
      // Skip the initial mount "online" stamp (prev === undefined) and any
      // online→online no-op renders. Only a recovery-from-degraded triggers.
      return;
    }

    const reconnectAt = now();
    const degradedSince = degradedSinceRef.current;
    degradedSinceRef.current = undefined;

    const controller = new AbortController();
    const idempotencyKey = newIdempotencyKey();
    const fetchFn = fetchImpl ?? globalThis.fetch.bind(globalThis);

    void (async () => {
      let outcome: SyncOutcome;
      let status: number | undefined;
      let itemsRemaining: number | undefined;
      try {
        const response = await fetchFn("/api/v1/queue/sync", {
          method: "POST",
          credentials: "include",
          signal: controller.signal,
          headers: {
            "Idempotency-Key": idempotencyKey,
            "Content-Type": "application/json",
          },
          body: "{}",
        });
        status = response.status;
        if (response.ok) {
          outcome = "success";
          // The §7.5.2 wire shape includes `itemsRemaining`. We pull it
          // best-effort for the log; a JSON-parse failure (defensive — the
          // BFF always emits JSON) just leaves the field undefined.
          try {
            const payload = (await response.json()) as {
              readonly itemsRemaining?: number;
            };
            itemsRemaining = payload.itemsRemaining;
          } catch {
            // Defensive: leave itemsRemaining undefined.
          }
        } else if (response.status === 429) {
          outcome = "rate_limited";
        } else {
          outcome = "server_error";
        }
      } catch (err) {
        outcome =
          err instanceof DOMException && err.name === "AbortError"
            ? "aborted"
            : "network_error";
      }

      const elapsedMsFromDegradedToTrigger =
        degradedSince !== undefined ? reconnectAt - degradedSince : undefined;

      // PWABootstrap-style log shape. JSON-serializable, no PII (idempotency
      // key is allowed identifier per the audit-log conventions). Playwright
      // E2E asserts against the message prefix.
      console.info("[anthos.sync_sla] queue.sync_triggered_after_reconnect", {
        surface: "iframe",
        trigger_source: "healthz_heartbeat",
        outcome,
        status,
        items_remaining: itemsRemaining,
        elapsed_ms_from_degraded_to_trigger: elapsedMsFromDegradedToTrigger,
      });
    })();

    return () => {
      controller.abort();
    };
  }, [state, fetchImpl, now]);

  return null;
}
