"use client";

// P3C-11 — AC-52 sync-SLA observability for the tablet PWA surface
// (ADR-05 success branch per SAD v1.2 §6.5a). Reconnect-detection on this
// surface is owned by Serwist's `BackgroundSyncPlugin` (`sw.ts`), which
// replays the IndexedDB Outbox on the `sync` event (Chromium) or next
// page-load `online` event (WebKit). This component does NOT trigger
// anything — it only measures the time from "reconnect" (browser `online`
// event, or page mount with items already queued) to "first replay
// attempt" (the SW posts an `outbox.replay_started` message the instant
// its `sync` handler fires; see `sw.ts`). AC-52 wording is "begin
// flushing within 60 seconds" — that is the moment we capture, not the
// completion of the first Salesforce roundtrip.
//
// Cross-surface isolation. Mounted unconditionally at the root layout,
// guarded internally by `isTopLevelOriginSurface()`: on the desktop
// Salesforce-iframe surface this component is inert (no listeners, no
// timers, no outbox reads). The iframe's AC-52 trigger lives in
// `SyncOnReconnect.tsx`.
//
// Log shape mirrors `PWABootstrap.tsx` precedent: `console.info("[anthos.<module>]
// event_name", { fields })`. JSON-serializable, no PII. Playwright E2E
// asserts against the prefix via `page.on("console")`.

import { useEffect, useRef } from "react";

import { list as listOutbox } from "../../_lib/offline/outbox";
import { isTopLevelOriginSurface } from "../../_lib/offline/pwa-surface";
import type { OutboxReplayStartedMessage } from "../../_lib/offline/types";

const SLA_DEADLINE_MS = 60_000;

interface Props {
  // Test seam — defaults to `Date.now`.
  readonly now?: () => number;
  // Test seam — defaults to the outbox `list()` implementation. Tests
  // inject a deterministic count without populating IndexedDB.
  readonly snapshotPendingCount?: () => Promise<number>;
}

interface OpenWindow {
  readonly reason: "online_event" | "page_mount";
  readonly openedAt: number;
  readonly itemsAtOpen: number;
}

export function SyncObserver({ now = Date.now, snapshotPendingCount }: Props = {}) {
  // A ref instead of state — this is observability bookkeeping that should
  // never cause a re-render. The component renders `null` regardless.
  const windowRef = useRef<OpenWindow | undefined>(undefined);
  const slaTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    // Cross-surface isolation. The iframe surface uses /healthz + SyncOnReconnect;
    // never run this observer there.
    if (!isTopLevelOriginSurface()) {
      return;
    }

    const snapshot =
      snapshotPendingCount ?? (async () => (await listOutbox()).length);

    const closeWindow = (): void => {
      windowRef.current = undefined;
      if (slaTimerRef.current !== undefined) {
        clearTimeout(slaTimerRef.current);
        slaTimerRef.current = undefined;
      }
    };

    const openWindow = (reason: OpenWindow["reason"], itemsAtOpen: number): void => {
      // A fresh open replaces any in-flight window — the most recent
      // reconnect is the one we measure against.
      if (slaTimerRef.current !== undefined) {
        clearTimeout(slaTimerRef.current);
      }
      const opened: OpenWindow = { reason, openedAt: now(), itemsAtOpen };
      windowRef.current = opened;
      slaTimerRef.current = setTimeout(() => {
        // Only fire if the window we set is the same one still open — a
        // race-safe guard for back-to-back online events that re-open
        // before the timer fires.
        if (windowRef.current !== opened) return;
        console.warn("[anthos.sync_sla] outbox.sync_sla_violation", {
          surface: "pwa",
          trigger_source: "serwist_background_sync",
          reason,
          items_at_open: itemsAtOpen,
          elapsed_ms_since_open: SLA_DEADLINE_MS,
        });
        closeWindow();
      }, SLA_DEADLINE_MS);
    };

    const onMessage = (event: MessageEvent): void => {
      // Defensive — narrow the broad MessageEvent type to the SW contract
      // (`OutboxReplayStartedMessage`) we own. Anything else is ignored.
      const data = event.data as unknown;
      if (
        typeof data !== "object" ||
        data === null ||
        (data as { type?: unknown }).type !== "outbox.replay_started"
      ) {
        return;
      }
      const message = data as OutboxReplayStartedMessage;
      const open = windowRef.current;
      // A `replay_started` with no open window most commonly means the SW
      // fired `sync` at startup before the page-side `online` listener saw
      // its first event — still useful to log, but `elapsed_ms_since_open`
      // is undefined.
      const elapsedMsSinceOpen =
        open !== undefined ? now() - open.openedAt : undefined;
      console.info("[anthos.sync_sla] outbox.replay_started", {
        surface: "pwa",
        trigger_source: "serwist_background_sync",
        reason: open?.reason,
        items_at_open: open?.itemsAtOpen,
        elapsed_ms_since_open: elapsedMsSinceOpen,
        sw_at: message.at,
      });
      closeWindow();
    };

    const onOnline = (): void => {
      void snapshot().then((count) => {
        if (count > 0) openWindow("online_event", count);
      });
    };

    // Page-mount snapshot. If we load up with already-queued items (e.g.,
    // the tab was closed offline and reopened online), the browser never
    // fires `online` because the connection was up the whole time. The
    // SW's `sync` event still fires at startup, so we open a window here
    // to measure mount → first-replay-started.
    void snapshot().then((count) => {
      if (count > 0) openWindow("page_mount", count);
    });

    window.addEventListener("online", onOnline);
    navigator.serviceWorker.addEventListener("message", onMessage);

    return () => {
      window.removeEventListener("online", onOnline);
      navigator.serviceWorker.removeEventListener("message", onMessage);
      if (slaTimerRef.current !== undefined) {
        clearTimeout(slaTimerRef.current);
        slaTimerRef.current = undefined;
      }
      windowRef.current = undefined;
    };
  }, [now, snapshotPendingCount]);

  return null;
}

export { SLA_DEADLINE_MS };
