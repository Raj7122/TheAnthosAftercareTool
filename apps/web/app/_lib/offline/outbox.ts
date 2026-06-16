// P3C-01 — IndexedDB Outbox for queued mutations on the tablet PWA surface
// (TR-OFFLINE-1, TR-OFFLINE-3, TR-OFFLINE-7b; Pattern C).
//
// Storage: `idb-keyval` with a dedicated database (`OUTBOX_DB_NAME`) so
// session-expiry wipe (TR-OFFLINE-9) can `indexedDB.deleteDatabase(name)`
// without touching any other state. Each row is keyed by `QueuedAction.id`,
// which is the same UUID used as the idempotency key — one row per attempt.
//
// This module owns the page-side queue record. Workbox `BackgroundSyncPlugin`
// in `sw.ts` keeps its OWN parallel queue of `Request` objects keyed by
// matcher+timestamp; the two are intentionally redundant: the SW queue is
// what actually replays bytes on reconnect, and this module's queue is what
// the UI (P3C-12 indicator, P3C-08 Review Required surface) reads without
// reaching into Workbox internals.

import { newIdempotencyKey } from "@anthos/domain";
import { createStore, del, entries, get, set, clear } from "idb-keyval";

import type { QueuedAction, QueuedActionMethod } from "./types";
import { OUTBOX_DB_NAME, OUTBOX_STORE_NAME } from "./types";

// A singleton store per page lifetime. `createStore` is cheap (it opens an
// IndexedDB connection lazily on first op), but we want every helper to
// share the same connection so a Promise queue inside `idb-keyval` can
// serialize concurrent writes.
let storeSingleton: ReturnType<typeof createStore> | null = null;
function outboxStore() {
  if (storeSingleton === null) {
    storeSingleton = createStore(OUTBOX_DB_NAME, OUTBOX_STORE_NAME);
  }
  return storeSingleton;
}

// Re-open the store after a `deleteDatabase` (wipe-on-expiry) so the next
// enqueue lands in a fresh IDB instead of throwing `InvalidStateError`.
export function resetOutboxStoreForTests(): void {
  storeSingleton = null;
  changeListeners.clear();
}

// P3C-13 — change-notification fan-out. The Outbox has no native change
// stream (idb-keyval is request/response), so `useOutbox()` cannot know when
// a row was added or removed without polling. A tiny in-module listener set,
// notified by every mutator below, lets the hook re-read `list()` on demand.
// Single-tab is sufficient for the tablet kiosk surface; a BroadcastChannel
// would be the cross-tab upgrade if that ever becomes a real case.
const changeListeners = new Set<() => void>();

// Subscribe to Outbox mutations (enqueue / remove / clearAll). Returns an
// unsubscribe handle. Listeners are invoked synchronously after the write
// resolves; a throwing listener must not break the fan-out, so each call is
// isolated.
export function subscribeOutbox(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => {
    changeListeners.delete(listener);
  };
}

function notifyOutboxChanged(): void {
  for (const listener of changeListeners) {
    try {
      listener();
    } catch {
      // A misbehaving subscriber must not stall the others or the caller.
    }
  }
}

export interface EnqueueInput {
  readonly endpoint: string;
  readonly method: QueuedActionMethod;
  readonly body: unknown;
  // P3C-13 — when the caller already minted a Pattern D key for an in-flight
  // request (e.g. the Log Call sheet mints at sheet-open), the Outbox mirror
  // MUST carry that SAME key so a page-side `replayOutbox()` and the SW
  // `BackgroundSyncPlugin` both dedupe to one server write. Omitted → a fresh
  // mint (TR-OFFLINE-6a) for callers with no in-flight request.
  readonly idempotencyKey?: string;
}

// Enqueue an action. Idempotency key defaults to a fresh mint NOW
// (TR-OFFLINE-6a): after persistence, a reload-then-flush carries the same
// key the first attempt would have, so Pattern D's middleware returns the
// cached response on the server-side duplicate. Callers with an in-flight
// request pass `idempotencyKey` to reuse the in-flight key instead. Either
// way `id === idempotencyKey`, so re-enqueuing the same key is idempotent at
// the IDB layer (a `set()` on the same row id, never a duplicate row).
export async function enqueue(
  input: EnqueueInput,
  now: () => number = Date.now,
): Promise<QueuedAction> {
  const idempotencyKey = input.idempotencyKey ?? newIdempotencyKey();
  const action: QueuedAction = {
    id: idempotencyKey,
    endpoint: input.endpoint,
    method: input.method,
    body: input.body,
    idempotencyKey,
    enqueuedAt: now(),
    retryCount: 0,
    state: "pending_sync",
  };
  await set(action.id, action, outboxStore());
  notifyOutboxChanged();
  return action;
}

// List the queued actions in stable enqueue order. The `entries()` IDB call
// returns key-value pairs; we sort by `enqueuedAt` so the UI sees FIFO and
// the flush loop replays in the original order (matters for participant-
// scoped sequences like "log call, then close barrier on the same row").
export async function list(): Promise<QueuedAction[]> {
  const all = await entries<string, QueuedAction>(outboxStore());
  return all
    .map(([, value]) => value)
    .sort((a, b) => a.enqueuedAt - b.enqueuedAt);
}

export async function getById(id: string): Promise<QueuedAction | undefined> {
  return await get<QueuedAction>(id, outboxStore());
}

export async function remove(id: string): Promise<void> {
  await del(id, outboxStore());
  notifyOutboxChanged();
}

// Used by the session-expiry wipe (TR-OFFLINE-9) when a `deleteDatabase`
// isn't possible (e.g., from a tab without elevated permission). Page-side
// callers should prefer `wipeOutbox()` from `wipe-on-expiry.ts`.
export async function clearAll(): Promise<void> {
  await clear(outboxStore());
  notifyOutboxChanged();
}
