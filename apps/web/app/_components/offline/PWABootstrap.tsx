"use client";

// P3C-01 — client-only mount point for the tablet PWA surface
// (ADR-05 §6.5a). Renders nothing visible; its job is two side effects:
//
//   1. Register the Service Worker on first hydration, guarded by
//      `isTopLevelOriginSurface()` so we never call `register()` from inside
//      the Salesforce Lightning Web Tab iframe (PF-05 spike). Errors are
//      swallowed to a `console.warn` — a failed registration on an
//      otherwise-eligible surface degrades the offline path but must not
//      take down the page.
//   2. Start the session-expiry watcher so a `BroadcastChannel('anthos-session')`
//      message — and the defensive 30-second sweep — wipes the IndexedDB
//      Outbox within the 1-minute TR-OFFLINE-9 budget.
//
// `useEffect` with an empty dep array fires exactly once per tab. Cleanup
// returns the watcher's stop handle so unmounting (StrictMode dev double-
// invoke, navigation away from layout) tears the listener down.

import { useEffect } from "react";

import { registerOfflineServiceWorker } from "../../_lib/offline/register-sw";
import { watchForSessionExpiry } from "../../_lib/offline/wipe-on-expiry";

export function PWABootstrap(): null {
  useEffect(() => {
    void registerOfflineServiceWorker().catch((error: unknown) => {
      // Pattern-B-shaped log line: structured failure surface without PII.
      console.warn("[anthos.pwa] sw_registration_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    const stop = watchForSessionExpiry();
    return stop;
  }, []);
  return null;
}
