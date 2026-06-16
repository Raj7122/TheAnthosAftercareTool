"use client";

// P3C-13 — page-side honest Outbox replay for the tablet PWA surface.
//
// On reconnect the tool replays queued Log Call mirrors HERE, on the page,
// rather than relying solely on the SW `BackgroundSyncPlugin`. Why two
// replayers? The SW queue replays the captured `Request` BYTES (the
// belt-and-suspenders guarantee that survives a closed tab), but it is opaque
// to the page — we cannot turn its progress into a trustworthy "Synced ✓".
// This page-side replay re-sends each row with its STORED idempotency key and
// `remove()`s on a real 2xx, so the UI's "Synced ✓" reflects a confirmed
// server write, not a guess.
//
// Double-replay safety (Pattern D): both this replay and the SW replay carry
// the SAME stored `Idempotency-Key`. `withIdempotency` returns the cached 2xx
// for the second arrival, so exactly one `IDW_Case_Note__c` and one audit row
// result. INVARIANT — a replay must NEVER mint a new key; reuse the stored one.
//
// Transient status: `pending_sync → syncing → synced` is UI-only and lives in
// the external store below, NEVER persisted to IndexedDB (`QueuedAction.state`
// stays the single literal `"pending_sync"`). A 2xx'd row is removed from IDB
// immediately, then flashed "synced" for `FLASH_MS` from a snapshot held here
// so `useOutbox` can render the checkmark after the row is gone.

import { list, remove } from "./outbox";
import type { QueuedAction } from "./types";

export type OutboxUiStatus = "pending_sync" | "syncing" | "synced";

type TransientEntry =
  | { readonly status: "syncing" }
  // `row` is the snapshot captured at send time so the "Synced ✓" flash can
  // render after the persisted row is removed from IDB.
  | { readonly status: "synced"; readonly row: QueuedAction };

// How long the "Synced ✓" checkmark lingers after a confirmed write before
// the row drops out of the panel entirely.
const FLASH_MS = 1500;

// ---- transient external store (useSyncExternalStore-compatible) ----------

const transient = new Map<string, TransientEntry>();
const transientListeners = new Set<() => void>();
// Cached immutable snapshot — `useSyncExternalStore` requires getSnapshot to
// return a stable reference between renders unless the data actually changed.
let snapshot: ReadonlyMap<string, TransientEntry> = new Map();

function emitTransient(): void {
  snapshot = new Map(transient);
  for (const listener of transientListeners) {
    try {
      listener();
    } catch {
      // A misbehaving subscriber must not stall the fan-out.
    }
  }
}

export function subscribeTransientStatus(listener: () => void): () => void {
  transientListeners.add(listener);
  return () => {
    transientListeners.delete(listener);
  };
}

export function getTransientStatusSnapshot(): ReadonlyMap<string, TransientEntry> {
  return snapshot;
}

// Test seam — drops all transient state + listeners between cases.
export function resetReplayStateForTests(): void {
  transient.clear();
  transientListeners.clear();
  snapshot = new Map();
  inFlight = false;
}

function setSyncing(id: string): void {
  transient.set(id, { status: "syncing" });
  emitTransient();
}

function setSynced(row: QueuedAction): void {
  transient.set(row.id, { status: "synced", row });
  emitTransient();
}

function clearTransient(id: string): void {
  if (transient.delete(id)) emitTransient();
}

function defaultSchedule(cb: () => void, ms: number): void {
  void setTimeout(cb, ms);
}

// Remove a confirmed row from the Outbox and flash "Synced ✓" for a moment.
// Shared by the page-side replay (reconnect path) AND the online Log Call
// mirror (`with-outbox-mirror`) so both paths render the SAME honest signal:
// the row is gone from IDB but lingers as a checkmark from the snapshot.
export async function flashSynced(
  row: QueuedAction,
  options: { readonly flashMs?: number; readonly schedule?: (cb: () => void, ms: number) => void } = {},
): Promise<void> {
  await remove(row.id);
  setSynced(row);
  (options.schedule ?? defaultSchedule)(
    () => clearTransient(row.id),
    options.flashMs ?? FLASH_MS,
  );
}

// ---- replay ---------------------------------------------------------------

export type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface ReplayOptions {
  readonly fetchImpl?: FetchLike;
  // Test seam — override the "Synced ✓" flash duration (and scheduler).
  readonly flashMs?: number;
  readonly schedule?: (cb: () => void, ms: number) => void;
}

type SendResult = "synced" | "network_error" | "rejected";

// Single-flight guard: the offline→online edge and the SW
// `outbox.replay_started` message can both fire `replayOutbox()` at nearly the
// same instant. Without this, the page would race itself re-POSTing the same
// rows. (Pattern D would still keep the server correct, but we'd waste calls
// and double-flip transient state.)
let inFlight = false;

function defaultFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return globalThis.fetch(input, init);
}

// Send one queued row with its stored idempotency key. Shape mirrors
// `caseload/_lib/send-mutation.ts` (same headers / credentials / cache) so the
// replay is byte-for-byte the original request modulo nothing. Classifies the
// outcome into the three the replay loop cares about — we don't need the full
// error envelope here, only synced vs still-offline vs server-rejected.
async function sendOne(fetchImpl: FetchLike, row: QueuedAction): Promise<SendResult> {
  let res: Response;
  try {
    res = await fetchImpl(row.endpoint, {
      method: row.method,
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": row.idempotencyKey,
      },
      body: JSON.stringify(row.body),
      cache: "no-store",
      credentials: "same-origin",
    });
  } catch {
    return "network_error";
  }
  return res.ok ? "synced" : "rejected";
}

// Replay every queued row in FIFO order. Returns when the queue is drained,
// the device is offline again, or a row is server-rejected.
//   - 2xx        → remove() now, flash "Synced ✓" from a snapshot, then drop.
//   - network    → still offline; clear "syncing", STOP (later rows would also
//                  fail; leave them queued for the next reconnect / the SW).
//   - rejected   → server said no (e.g. VR-18, reassigned); clear "syncing" and
//                  leave the row queued so it surfaces (Review Required / retry)
//                  — do NOT silently drop, do NOT block later rows.
export async function replayOutbox(options: ReplayOptions = {}): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  const fetchImpl = options.fetchImpl ?? defaultFetch;
  const flashMs = options.flashMs ?? FLASH_MS;
  const schedule = options.schedule ?? defaultSchedule;
  try {
    const rows = await list();
    for (const row of rows) {
      setSyncing(row.id);
      const result = await sendOne(fetchImpl, row);
      if (result === "synced") {
        await flashSynced(row, { flashMs, schedule });
      } else if (result === "network_error") {
        clearTransient(row.id);
        break;
      } else {
        clearTransient(row.id);
      }
    }
  } finally {
    inFlight = false;
  }
}
