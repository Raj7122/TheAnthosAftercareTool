// P3C-01 — IndexedDB wipe on session expiry within 1 minute
// (TR-OFFLINE-9 / ARC-30).
//
// Two triggers, belt-and-suspenders:
//
//  1. The auth surface broadcasts `{ type: 'expired' }` on
//     `BroadcastChannel('anthos-session')` at logout / refresh-failure. Page
//     and SW both listen on the same channel.
//  2. A 30-second `setInterval` defensively re-runs the wipe trigger so
//     a missed channel event (tab was discarded, BroadcastChannel not
//     supported, etc.) still satisfies the 60-second TR-OFFLINE-9 budget.
//     The defensive sweep is a no-op when there is no signal — it does NOT
//     poll any endpoint on its own (P3C-11 / P3C-03 own the heartbeat).
//
// The actual signal the defensive sweep checks for is a `lastExpiryAt`
// flag the channel listener stores; if that flag is set, the database is
// torn down again (which is idempotent on an already-deleted DB).

import { clearAll } from "./outbox";
import { wipeDrafts } from "./drafts/wipe";
import { SESSION_BROADCAST_CHANNEL } from "./types";
import type { SessionBroadcastMessage } from "./types";

// Wipe semantics for TR-OFFLINE-9 / ARC-30: "no queued data remains after
// session expiry." The functional guarantee is that the Outbox is empty,
// not that the IndexedDB file is gone — and since `idb-keyval` does not
// expose a close handle on its internal connection (no `onversionchange` is
// installed), a `deleteDatabase` here would either block on the live
// connection or leak a pending request that blocks the next `open()`.
// `clear()` over the existing connection is the clean, deterministic
// guarantee. Subsequent enqueues reuse the same (empty) store.
export async function wipeOutbox(): Promise<void> {
  await clearAll();
}

interface WatchState {
  channel: BroadcastChannel | null;
  intervalId: ReturnType<typeof setInterval> | null;
  lastExpiryAt: number | null;
}

let active: WatchState | null = null;

// Returns a cleanup callback so callers (React effect, tests) can stop
// listening. Repeated calls without cleanup are a no-op — there is only ever
// one watcher per tab.
export function watchForSessionExpiry(
  options: {
    readonly sweepIntervalMs?: number;
    readonly now?: () => number;
  } = {},
): () => void {
  if (typeof window === "undefined") return () => {};
  if (active !== null) return stopWatching;

  const sweepIntervalMs = options.sweepIntervalMs ?? 30_000;
  const now = options.now ?? Date.now;
  const state: WatchState = {
    channel: null,
    intervalId: null,
    lastExpiryAt: null,
  };
  active = state;

  // `BroadcastChannel` is broadly supported (Safari 15.4+, all Chromium); a
  // missing global is treated as a non-fatal degradation — the defensive
  // sweep below still runs.
  if (typeof BroadcastChannel !== "undefined") {
    const channel = new BroadcastChannel(SESSION_BROADCAST_CHANNEL);
    channel.onmessage = (event: MessageEvent<SessionBroadcastMessage>) => {
      if (event.data?.type === "expired") {
        observeSessionExpiry(state, now);
      }
    };
    state.channel = channel;
  }

  state.intervalId = setInterval(() => {
    if (state.lastExpiryAt !== null) {
      // P3C-02 — wipe both the Outbox AND the drafts store; the functional
      // guarantee TR-OFFLINE-9 demands ("no queued data remains") applies
      // to every IndexedDB-backed surface the tablet PWA owns.
      void Promise.all([wipeOutbox(), wipeDrafts()]);
    }
  }, sweepIntervalMs);

  return stopWatching;
}

// Shared handler the channel listener and the test seam both go through.
// Keeping it factored makes the watcher's branching auditable from one
// place and lets tests drive expiry deterministically without depending on
// the host environment's BroadcastChannel delivery model.
function observeSessionExpiry(state: WatchState, now: () => number): void {
  state.lastExpiryAt = now();
  // P3C-02 — wipe both the Outbox and the drafts store. Promise.all so a
  // hung clear() on one store does not delay the other; both reject paths
  // are intentionally unhandled here since the defensive sweep above will
  // re-run on the next tick if either rejected.
  void Promise.all([wipeOutbox(), wipeDrafts()]);
}

// Test-only seam: simulate a session-expiry signal directly against the
// active watcher. The production path goes through BroadcastChannel
// (`SESSION_BROADCAST_CHANNEL`); tests use this to avoid happy-dom /
// fake-indexeddb timing variance in cross-instance message delivery.
export function simulateSessionExpiryForTests(now: () => number = Date.now): void {
  if (active === null) return;
  observeSessionExpiry(active, now);
}

function stopWatching(): void {
  if (active === null) return;
  if (active.channel !== null) active.channel.close();
  if (active.intervalId !== null) clearInterval(active.intervalId);
  active = null;
}

// Test-only: clear any in-process watcher state so a fresh test can install
// its own listener.
export function resetWatcherForTests(): void {
  stopWatching();
}
