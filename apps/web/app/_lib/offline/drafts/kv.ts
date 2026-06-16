// P3C-02 — Singleton `idb-keyval` store handle for the drafts database.
// Mirrors the outbox singleton pattern in `../outbox.ts` lines 26–32: one
// `createStore` per page lifetime so idb-keyval's internal Promise queue
// serializes concurrent writes against the same IDB connection.

import { createStore } from "idb-keyval";

import { DRAFTS_DB_NAME, DRAFTS_STORE_NAME } from "./types";

let storeSingleton: ReturnType<typeof createStore> | null = null;

export function draftsKvStore(): ReturnType<typeof createStore> {
  if (storeSingleton === null) {
    storeSingleton = createStore(DRAFTS_DB_NAME, DRAFTS_STORE_NAME);
  }
  return storeSingleton;
}

// Re-open the store after `clearAll`-via-wipe or a fake "reload" in tests so
// the next call lands in a fresh IDB connection. The Outbox exposes the same
// seam (`resetOutboxStoreForTests`) and is consumed by `test/offline/*`.
export function resetDraftsKvStoreForTests(): void {
  storeSingleton = null;
}
