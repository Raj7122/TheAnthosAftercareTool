"use client";

// P3C-13 — the F-14 Pending Sync view model for the tablet home.
//
// The Outbox (`outbox.ts`) is the UI source of truth for queued/syncing Log
// Call mirrors; this hook turns it into render-ready rows. It joins two
// sources:
//   1. PERSISTED rows from IndexedDB (`list()`), re-read whenever a mutator
//      fires `subscribeOutbox` (enqueue / remove / clearAll).
//   2. TRANSIENT status from `replay.ts` (`pending_sync → syncing → synced`),
//      consumed via `useSyncExternalStore`. A row mid-replay shows "syncing";
//      a just-confirmed row is removed from IDB but flashed "synced" for a
//      moment from the transient snapshot.
//
// `count` (the header badge) is the number of PERSISTED rows — work genuinely
// still waiting to sync. "synced" flashes are already gone from IDB, so they
// don't inflate the badge: the badge is honest about unsynced work.

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

import { list, subscribeOutbox } from "./outbox";
import {
  getTransientStatusSnapshot,
  subscribeTransientStatus,
  type OutboxUiStatus,
} from "./replay";
import type { QueuedAction } from "./types";

export interface OutboxItem extends QueuedAction {
  readonly uiStatus: OutboxUiStatus;
}

export interface OutboxView {
  readonly items: ReadonlyArray<OutboxItem>;
  // Persisted rows still awaiting a confirmed sync (pending + in-flight).
  // Drives the header pending badge.
  readonly count: number;
}

export function useOutbox(): OutboxView {
  const [persisted, setPersisted] = useState<ReadonlyArray<QueuedAction>>([]);

  const reload = useCallback(async (): Promise<void> => {
    setPersisted(await list());
  }, []);

  useEffect(() => {
    let active = true;
    const run = (): void => {
      void list().then((rows) => {
        if (active) setPersisted(rows);
      });
    };
    run();
    const unsubscribe = subscribeOutbox(run);
    return () => {
      active = false;
      unsubscribe();
    };
  }, [reload]);

  const transientSnap = useSyncExternalStore(
    subscribeTransientStatus,
    getTransientStatusSnapshot,
    // Server snapshot — no transient state during SSR.
    getTransientStatusSnapshot,
  );

  const persistedIds = new Set(persisted.map((row) => row.id));

  const items: OutboxItem[] = [
    // Persisted rows carry their transient overlay (syncing) or default to
    // pending_sync.
    ...persisted.map((row) => ({
      ...row,
      uiStatus: transientSnap.get(row.id)?.status ?? ("pending_sync" as const),
    })),
    // "synced" flashes for rows already removed from IDB — render from the
    // snapshot the replay captured so the checkmark survives the removal.
    ...[...transientSnap.entries()]
      .filter(
        ([id, entry]) => entry.status === "synced" && !persistedIds.has(id),
      )
      .map(([, entry]) => ({
        ...(entry as { status: "synced"; row: QueuedAction }).row,
        uiStatus: "synced" as const,
      })),
  ].sort((a, b) => a.enqueuedAt - b.enqueuedAt);

  return { items, count: persisted.length };
}
