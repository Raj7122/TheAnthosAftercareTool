"use client";

// P3C-13 — the page-side actor that drains the Outbox on reconnect.
//
// Pairs with `SyncObserver` (which only MEASURES the AC-52 SLA): this
// component TRIGGERS `replayOutbox()`, giving the UI an honest "Synced ✓"
// backed by a confirmed server write rather than the opaque SW queue. The SW
// `BackgroundSyncPlugin` remains the belt-and-suspenders for a closed tab;
// Pattern D (shared stored idempotency key) makes the two replays dedupe to a
// single write.
//
// Triggers:
//   - the offline→online edge (`subscribeReconnect`, i.e. the browser `online`
//     event), and
//   - the SW `outbox.replay_started` message (the SW began its own replay —
//     we run the page-side drain alongside it for the confirmed signal), and
//   - mount-while-online-with-queued-rows (a tab closed offline and reopened
//     on a live connection never fires `online`), and
//   - a poll-while-pending fallback (below): while the Outbox holds rows, a
//     short interval re-attempts the drain when `navigator.onLine` is true.
//     The `online` event is unreliably delivered on real wifi/airplane-mode
//     toggles (notably iPad Safari, which also lacks the Background Sync API),
//     so without this the queue sits until a manual refresh re-runs the
//     mount-time drain. The poll makes the drain insensitive to whether the
//     edge event ever fired; `replayOutbox`'s single-flight + Pattern D
//     idempotency keep it safe against the other triggers firing concurrently.
//
// Cross-surface isolation: guarded by `isTopLevelOriginSurface()`, inert on
// the desktop Salesforce-iframe surface (which reconnects via /healthz +
// `SyncOnReconnect`). The poll reads only the local Outbox + the
// `navigator.onLine` flag — no /healthz probe, no connectivity state machine.
// Renders nothing.

import { useEffect } from "react";

import { subscribeReconnect } from "../../_lib/connectivity/use-online";
import { list as listOutbox, subscribeOutbox } from "../../_lib/offline/outbox";
import { isTopLevelOriginSurface } from "../../_lib/offline/pwa-surface";
import { replayOutbox } from "../../_lib/offline/replay";
import type { OutboxReplayStartedMessage } from "../../_lib/offline/types";

// How often the poll-while-pending fallback re-attempts the drain. 3s keeps
// the reconnect feeling near-instant on the demo stage while comfortably
// inside the AC-52 60s "begin flushing" window.
const DEFAULT_POLL_INTERVAL_MS = 3_000;

interface Props {
  // Test seam — defaults to the real `replayOutbox`. Tests inject a spy to
  // assert trigger wiring without touching IndexedDB / fetch.
  readonly replay?: () => void;
  // Test seam — overrides the poll-while-pending interval (default 3s).
  readonly pollIntervalMs?: number;
}

export function OutboxReplayer({ replay, pollIntervalMs = DEFAULT_POLL_INTERVAL_MS }: Props = {}) {
  useEffect(() => {
    if (!isTopLevelOriginSurface()) {
      return;
    }
    const runReplay = replay ?? ((): void => void replayOutbox());

    const onReconnect = (): void => runReplay();
    const unsubscribeReconnect = subscribeReconnect(onReconnect);

    const onMessage = (event: MessageEvent): void => {
      const data = event.data as unknown;
      if (
        typeof data !== "object" ||
        data === null ||
        (data as { type?: unknown }).type !== "outbox.replay_started"
      ) {
        return;
      }
      // Narrowed to the SW contract we own (informational fields unused here).
      void (data as OutboxReplayStartedMessage);
      runReplay();
    };
    navigator.serviceWorker.addEventListener("message", onMessage);

    // Mount-time drain: if we loaded online with rows already queued (closed
    // offline, reopened connected), no `online` event will fire — attempt the
    // drain now. The `inFlight` guard inside `replayOutbox` keeps this from
    // racing a near-simultaneous SW message.
    if (navigator.onLine) {
      void listOutbox().then((rows) => {
        if (rows.length > 0) runReplay();
      });
    }

    // Poll-while-pending fallback. Runs ONLY while the Outbox holds rows, and
    // each tick attempts the drain ONLY when `navigator.onLine` is true:
    //   - gating on `navigator.onLine` avoids firing failed POSTs while
    //     genuinely offline, which would bloat the SW BackgroundSync queue and
    //     flicker the panel's "syncing" state every interval, and
    //   - `runReplay` → `replayOutbox`'s `inFlight` guard absorbs a tick that
    //     lands mid-replay, so this never races the edge/SW triggers.
    let intervalId: ReturnType<typeof setInterval> | undefined;
    const tick = (): void => {
      if (navigator.onLine) runReplay();
    };
    const startPolling = (): void => {
      if (intervalId === undefined) {
        intervalId = setInterval(tick, pollIntervalMs);
      }
    };
    const stopPolling = (): void => {
      if (intervalId !== undefined) {
        clearInterval(intervalId);
        intervalId = undefined;
      }
    };
    // Start when rows exist, stop when the Outbox drains. `subscribeOutbox`
    // fires on enqueue/remove/clearAll, so a confirmed write's `remove()` stops
    // the interval within one `list()` round-trip of the last row clearing.
    const syncToOutbox = (): void => {
      void listOutbox().then((rows) => {
        if (rows.length > 0) startPolling();
        else stopPolling();
      });
    };
    const unsubscribeOutbox = subscribeOutbox(syncToOutbox);
    // Initial evaluation: covers losing connection, writing a note (so the
    // `online` event never fired), then waiting — the poll keeps retrying until
    // `navigator.onLine` flips true. Also restarts polling on a remount that
    // loaded offline with rows already queued.
    syncToOutbox();

    return () => {
      unsubscribeReconnect();
      navigator.serviceWorker.removeEventListener("message", onMessage);
      unsubscribeOutbox();
      stopPolling();
    };
  }, [replay, pollIntervalMs]);

  return null;
}
