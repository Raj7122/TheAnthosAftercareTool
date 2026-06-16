// P3C-01 — client-side Outbox row shape for the tablet PWA surface
// (ADR-05 §6.5a; SAD v1.2 §6.5a).
//
// This is the in-browser representation a `QueuedAction`. It is NOT the
// server-side `offline_queue` row (P3C-04 / ERD §12.1) — that table mirrors
// only review_required + dead-letter items. A successful 2xx flush leaves
// no server-side queue row; the idempotency_keys table is the audit surface
// for those (Pattern D).
//
// Per Pattern C: `idempotencyKey` is generated AT ENQUEUE (TR-OFFLINE-6a) so a
// reload-then-flush replay carries the same key the first attempt would have
// used, and Pattern D's middleware returns the cached response on the
// duplicate. `retryCount` is plumbed but not incremented here — P3C-09 owns
// the retry-budget transitions. `state` is narrowed to "pending_sync" for the
// foundation; P3C-08 widens it with the Review Required variants.

export type QueuedActionMethod = "POST" | "PATCH" | "DELETE";

export interface QueuedAction {
  readonly id: string;
  readonly endpoint: string;
  readonly method: QueuedActionMethod;
  readonly body: unknown;
  readonly idempotencyKey: string;
  readonly enqueuedAt: number;
  readonly retryCount: number;
  readonly state: "pending_sync";
}

// Channel name + payload contract for the auth surface's session-expiry
// broadcast (TR-OFFLINE-9 / ARC-30). Publishing the contract from P3C-01;
// the auth surface fills it in.
export const SESSION_BROADCAST_CHANNEL = "anthos-session" as const;

export type SessionBroadcastMessage = { readonly type: "expired" };

// Single keyval store under which the Outbox rows live. `idb-keyval` uses
// one IndexedDB database per `createStore(dbName, storeName)` pair; this
// constant is the dbName so a session-expiry wipe can `deleteDatabase()`
// it by name.
export const OUTBOX_DB_NAME = "anthos-outbox" as const;
export const OUTBOX_STORE_NAME = "queued-actions" as const;

// P3C-11 — Background-sync queue identity. The page-side outbox is stored
// independently of the SW's `BackgroundSyncPlugin` queue (see `outbox.ts`
// header), but they share this name so the two are joinable in logs and the
// SW can compose the `sync` event tag deterministically. Serwist's
// `BackgroundSyncQueue` registers `serwist-background-sync:<name>` as the
// sync tag (see serwist/dist BackgroundSyncQueue), so the SW-side replay
// broadcaster matches against `BACKGROUND_SYNC_TAG`.
export const OUTBOX_BACKGROUND_SYNC_QUEUE_NAME = "anthos-outbox-sw" as const;
export const BACKGROUND_SYNC_TAG =
  `serwist-background-sync:${OUTBOX_BACKGROUND_SYNC_QUEUE_NAME}` as const;

// P3C-11 — SW → page message contract for the AC-52 sync-SLA observability.
// The SW emits `outbox.replay_started` the moment Serwist's `sync` event
// fires for the Outbox queue tag; the page-side `SyncObserver` listens via
// `navigator.serviceWorker.addEventListener("message", ...)` and computes
// `elapsed_ms_from_online` against the most recent browser `online` event.
// Kept narrow on purpose: this is the canonical "begin flushing" signal
// (AC-52 wording), not a request-level event stream.
export type OutboxReplayStartedMessage = {
  readonly type: "outbox.replay_started";
  // `Date.now()` snapshot taken inside the SW's `sync` handler. Used by the
  // page-side observer to derive `elapsed_ms_from_online` if the page's own
  // clock is reliable; mostly informational since the observer uses its own
  // `Date.now()` on receipt as the canonical "begin" timestamp.
  readonly at: number;
};
