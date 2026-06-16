/// <reference lib="webworker" />

// P3C-01 — Service Worker entry point for the tablet PWA surface
// (ADR-05 §6.5a; SAD v1.2 §6.5a). Compiled by `@serwist/next` into
// `public/sw.js` at build time; the manifest list is injected at
// `self.__SW_MANIFEST` by the build plugin.
//
// Surface guarantee (PF-05): this code runs only when the page loaded at the
// tool's first-party origin top-level. `registerOfflineServiceWorker()`
// refuses to call `register()` when `window.self !== window.top`, so the SW
// never installs from inside the Salesforce Lightning Web Tab iframe.
//
// Runtime caching strategy (Pattern C):
//   - Mutating /api/v1/* requests: `NetworkOnly` + `BackgroundSyncPlugin`.
//     The plugin maintains its own Workbox-managed IndexedDB queue of
//     failed Requests and replays them via the `sync` event (Chromium) or
//     the next page-load `online` event (WebKit fallback). The 60-second
//     SLA (AC-52 / TR-OFFLINE-8) is met on Chromium directly and on WebKit
//     when the PWA is open during reconnect.
//   - Everything else: `defaultCache` from `@serwist/next/worker`, which
//     applies App-Router-appropriate SWR / pass-through strategies.
//
// `maxRetentionTime: 24 * 60` minutes mirrors the Pattern D 24h idempotency
// TTL so a queued request and its server-side idempotency key share the
// same liveness window — a queued entry that outlives its idempotency key
// would lose Pattern D's replay-safety guarantee.

import type { PrecacheEntry, SerwistGlobalConfig } from "serwist";
import { BackgroundSyncPlugin, NetworkOnly, Serwist } from "serwist";
import { defaultCache } from "@serwist/next/worker";

import {
  BACKGROUND_SYNC_TAG,
  OUTBOX_BACKGROUND_SYNC_QUEUE_NAME,
  OUTBOX_DB_NAME,
  SESSION_BROADCAST_CHANNEL,
  type OutboxReplayStartedMessage,
  type SessionBroadcastMessage,
} from "./app/_lib/offline/types";

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    readonly __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}

declare const self: ServiceWorkerGlobalScope &
  WorkerGlobalScope & {
    readonly __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  };

const outboxBackgroundSync = new BackgroundSyncPlugin(
  OUTBOX_BACKGROUND_SYNC_QUEUE_NAME,
  {
    maxRetentionTime: 24 * 60,
  },
);

// P3C-11 — AC-52 sync-SLA observability. Serwist's `BackgroundSyncQueue`
// registers a `sync` event listener internally that matches against
// `BACKGROUND_SYNC_TAG`; the browser dispatches the event to all registered
// listeners in registration order, so a parallel listener here fires
// alongside the plugin's without interfering with replay. We post a
// `outbox.replay_started` message to every visible client the moment the
// `sync` event fires for our Outbox queue, which is the canonical "begin
// flushing" signal AC-52 measures against (60s ceiling between reconnect
// and first replay attempt). `event.waitUntil` extends the SW lifetime
// across the `postMessage` fan-out so the message is delivered even if the
// SW is short-lived under iOS throttling. The page-side `SyncObserver`
// computes the `elapsed_ms_from_online` field — see `SyncObserver.tsx`.
//
// Listener ordering is immaterial: this handler is registered before
// `serwist.addEventListeners()` below, but the spec lets multiple
// `sync` listeners run independently — each `waitUntil` extends the SW
// lifetime and the browser waits for the union before terminating. The
// postMessage fan-out neither blocks nor consumes Serwist's replay path.
self.addEventListener("sync", (event: SyncEvent) => {
  if (event.tag !== BACKGROUND_SYNC_TAG) return;
  const message: OutboxReplayStartedMessage = {
    type: "outbox.replay_started",
    at: Date.now(),
  };
  event.waitUntil(
    self.clients.matchAll({ type: "window" }).then((clients) => {
      for (const client of clients) {
        client.postMessage(message);
      }
    }),
  );
});

const isMutatingApiRequest = ({ request }: { request: Request }) => {
  if (request.method === "GET" || request.method === "HEAD") return false;
  const url = new URL(request.url);
  return url.origin === self.location.origin && url.pathname.startsWith("/api/v1/");
};

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST ?? [],
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: true,
  runtimeCaching: [
    {
      matcher: isMutatingApiRequest,
      handler: new NetworkOnly({ plugins: [outboxBackgroundSync] }),
    },
    ...defaultCache,
  ],
});

serwist.addEventListeners();

// TR-OFFLINE-9 / ARC-30: session-expiry wipe within 1 minute. The page-side
// listener in `wipe-on-expiry.ts` owns the load-bearing `clearAll()` over
// the existing connection (idb-keyval does not expose a close handle, so a
// blind `deleteDatabase` from here would block on live page connections).
// This SW-side handler does two best-effort things:
//   - Drop all caches (no page-side dependency, so this is the SW's job).
//   - Issue a non-awaited `deleteDatabase` so the DB name is reclaimed
//     after the last connection closes (e.g., the tab refreshes after
//     logout). The page-side wipe is what guarantees zero rows remain.
const sessionChannel = new BroadcastChannel(SESSION_BROADCAST_CHANNEL);
sessionChannel.onmessage = (event: MessageEvent<SessionBroadcastMessage>) => {
  if (event.data?.type === "expired") {
    void caches
      .keys()
      .then((names) => Promise.all(names.map((name) => caches.delete(name))));
    try {
      indexedDB.deleteDatabase(OUTBOX_DB_NAME);
    } catch {
      // Best-effort cleanup; the page-side wipe is the actual guarantee.
    }
  }
};
