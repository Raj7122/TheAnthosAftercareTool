"use client";

// P3C-13 — dedicated online/offline signal for the tablet PWA surface.
//
// This is intentionally SEPARATE from `useConnectivity()` (context.tsx).
// `useConnectivity()` is PINNED "online" on the tablet surface and only does
// real work inside the desktop Salesforce iframe (where it polls /healthz and
// gates `SyncOnReconnect`'s `POST /queue/sync`). Un-pinning it to drive the
// tablet UI would change that iframe gating — so the tablet gets its own thin
// `navigator.onLine` reader instead. No /healthz, no state machine; just the
// browser's own connectivity flag plus its `online`/`offline` events.
//
// Two surfaces:
//   - `useOnline()` — a hook for UI labels/affordances (the Pending Sync
//     panel header copy, an offline banner). Re-renders on transitions.
//   - `subscribeReconnect()` — an imperative seam (no render) for the actor
//     that re-sends the Outbox on reconnect (`OutboxReplayer` → `replayOutbox`).
//     Fires on the offline→online edge, which is exactly when the browser
//     emits the `online` event.

import { useEffect, useState } from "react";

function readOnline(): boolean {
  // SSR / non-browser: assume online so the first paint never flashes an
  // offline state that hydration immediately corrects on a connected device.
  if (typeof navigator === "undefined") return true;
  return navigator.onLine;
}

export function useOnline(): boolean {
  const [online, setOnline] = useState<boolean>(readOnline);

  useEffect(() => {
    const up = (): void => setOnline(true);
    const down = (): void => setOnline(false);
    // Reconcile against the live value on mount in case it changed between the
    // initial `useState` snapshot and the effect running.
    setOnline(readOnline());
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);

  return online;
}

// Imperative offline→online edge subscription. The browser's `online` event
// fires on that edge specifically (it does NOT fire while already online), so
// a bare listener is the edge. Returns an unsubscribe handle. Safe to call in
// non-browser contexts (it no-ops and returns a no-op disposer).
export function subscribeReconnect(onReconnect: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("online", onReconnect);
  return () => {
    window.removeEventListener("online", onReconnect);
  };
}
