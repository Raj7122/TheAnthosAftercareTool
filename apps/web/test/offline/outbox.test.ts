// @vitest-environment happy-dom

// P3C-01 — Outbox IndexedDB round-trip + survival across connection reset
// (TR-OFFLINE-1, TR-OFFLINE-3, Pattern C).
//
// `fake-indexeddb/auto` shims `globalThis.indexedDB` with an in-memory
// implementation. happy-dom + the shim is the combination the project will
// also use for P3C-02's draft-persistence tests.

import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearAll,
  enqueue,
  getById,
  list,
  remove,
  resetOutboxStoreForTests,
  subscribeOutbox,
} from "../../app/_lib/offline/outbox";

beforeEach(async () => {
  // Empty the store over the live connection — see wipe-on-expiry.ts for
  // why we don't deleteDatabase here (idb-keyval has no close handle and a
  // blind delete would block on the in-process connection).
  await clearAll();
});

afterEach(async () => {
  await clearAll();
  resetOutboxStoreForTests();
});

describe("Outbox", () => {
  it("enqueues an action and reads it back with the same idempotency key", async () => {
    const action = await enqueue({
      endpoint: "/api/v1/participants/abc/log-call",
      method: "POST",
      body: { summary: "spoke with participant" },
    });
    expect(action.id).toBe(action.idempotencyKey);
    expect(action.state).toBe("pending_sync");
    expect(action.retryCount).toBe(0);

    const reloaded = await getById(action.id);
    expect(reloaded).toEqual(action);
  });

  it("returns queued actions in FIFO enqueue order", async () => {
    let t = 1_000;
    const now = () => t++;
    const first = await enqueue(
      { endpoint: "/api/v1/x/1", method: "POST", body: null },
      now,
    );
    const second = await enqueue(
      { endpoint: "/api/v1/x/2", method: "POST", body: null },
      now,
    );
    const third = await enqueue(
      { endpoint: "/api/v1/x/3", method: "POST", body: null },
      now,
    );

    const all = await list();
    expect(all.map((a) => a.id)).toEqual([first.id, second.id, third.id]);
  });

  it("survives a simulated reload by re-opening the same store (BR-69)", async () => {
    const a = await enqueue({
      endpoint: "/api/v1/x/1",
      method: "POST",
      body: { v: 1 },
    });
    const b = await enqueue({
      endpoint: "/api/v1/x/2",
      method: "POST",
      body: { v: 2 },
    });

    // Simulate a fresh page load: drop the in-memory store handle so the
    // next call re-opens IDB from scratch. The underlying IDB rows persist
    // (TR-OFFLINE-3 / BR-69 — queued actions persist across reload).
    resetOutboxStoreForTests();

    const after = await list();
    expect(after.map((row) => row.id).sort()).toEqual([a.id, b.id].sort());

    // TR-OFFLINE-6a behavioral lock: the enqueue-time `Idempotency-Key`
    // survives reload byte-identically. A post-reload replay carries the
    // SAME key the first attempt would have, so Pattern D's server-side
    // state machine returns the stored response instead of duplicating.
    const reloadedA = await getById(a.id);
    const reloadedB = await getById(b.id);
    expect(reloadedA?.idempotencyKey).toBe(a.idempotencyKey);
    expect(reloadedB?.idempotencyKey).toBe(b.idempotencyKey);
  });

  it("remove() deletes a single action by id; clearAll() empties the store", async () => {
    const a = await enqueue({ endpoint: "/x", method: "POST", body: null });
    const b = await enqueue({ endpoint: "/y", method: "POST", body: null });

    await remove(a.id);
    expect(await getById(a.id)).toBeUndefined();
    expect((await list()).map((r) => r.id)).toEqual([b.id]);

    await clearAll();
    expect(await list()).toEqual([]);
  });

  // P3C-13 — the Log Call mirror reuses the in-flight request's key so a
  // page-side + SW double-replay dedupes to one server write (Pattern D).
  it("reuses a caller-supplied idempotency key as both id and key", async () => {
    const action = await enqueue({
      endpoint: "/api/v1/participants/abc/calls",
      method: "POST",
      body: { status: "Completed" },
      idempotencyKey: "fixed-key-123",
    });
    expect(action.id).toBe("fixed-key-123");
    expect(action.idempotencyKey).toBe("fixed-key-123");

    // Re-enqueuing the same key is idempotent at the IDB layer (one row).
    await enqueue({
      endpoint: "/api/v1/participants/abc/calls",
      method: "POST",
      body: { status: "Completed" },
      idempotencyKey: "fixed-key-123",
    });
    expect((await list()).filter((r) => r.id === "fixed-key-123")).toHaveLength(
      1,
    );
  });

  it("default-mints a distinct key when none is supplied (regression)", async () => {
    const a = await enqueue({ endpoint: "/x", method: "POST", body: null });
    const b = await enqueue({ endpoint: "/x", method: "POST", body: null });
    expect(a.idempotencyKey).not.toBe(b.idempotencyKey);
    expect(a.id).toBe(a.idempotencyKey);
  });

  // P3C-13 — `useOutbox()` re-reads on these notifications (no native IDB
  // change stream).
  it("notifies subscribers on enqueue, remove, and clearAll", async () => {
    let calls = 0;
    const unsubscribe = subscribeOutbox(() => {
      calls += 1;
    });

    const a = await enqueue({ endpoint: "/x", method: "POST", body: null });
    expect(calls).toBe(1);
    await remove(a.id);
    expect(calls).toBe(2);
    await clearAll();
    expect(calls).toBe(3);

    unsubscribe();
    await enqueue({ endpoint: "/y", method: "POST", body: null });
    expect(calls).toBe(3); // no longer notified after unsubscribe
  });
});
