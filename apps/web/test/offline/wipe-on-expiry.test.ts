// @vitest-environment happy-dom

// P3C-01 — session-expiry wipe (TR-OFFLINE-9 / ARC-30).
// Two paths under test:
//   1. BroadcastChannel signal triggers wipe immediately.
//   2. Defensive 30-second sweep triggers wipe even after a missed
//      message — using `lastExpiryAt` set by an earlier observed event.
// happy-dom ships a working BroadcastChannel + indexedDB shim (with
// fake-indexeddb/auto for IDB).

import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clear as idbClear } from "idb-keyval";

import {
  clearAll,
  enqueue,
  list,
  resetOutboxStoreForTests,
} from "../../app/_lib/offline/outbox";
import {
  resetWatcherForTests,
  simulateSessionExpiryForTests,
  watchForSessionExpiry,
  wipeOutbox,
} from "../../app/_lib/offline/wipe-on-expiry";
import {
  resetMemoryStorageForTests,
  useDraftStore,
} from "../../app/_lib/offline/drafts/store";
import {
  draftsKvStore,
  resetDraftsKvStoreForTests,
} from "../../app/_lib/offline/drafts/kv";

beforeEach(async () => {
  resetWatcherForTests();
  await clearAll();
  await idbClear(draftsKvStore());
  useDraftStore.getState().resetAllForTests();
  resetMemoryStorageForTests();
});

afterEach(async () => {
  resetWatcherForTests();
  await clearAll();
  await idbClear(draftsKvStore());
  useDraftStore.getState().resetAllForTests();
  resetMemoryStorageForTests();
  resetOutboxStoreForTests();
  resetDraftsKvStoreForTests();
  vi.useRealTimers();
});

describe("session-expiry wipe", () => {
  it("wipeOutbox() empties the Outbox (TR-OFFLINE-9 functional guarantee)", async () => {
    await enqueue({ endpoint: "/x", method: "POST", body: { a: 1 } });
    expect((await list()).length).toBe(1);

    await wipeOutbox();

    expect(await list()).toEqual([]);
  });

  it("an observed session-expiry event clears the Outbox", async () => {
    await enqueue({ endpoint: "/x", method: "POST", body: null });
    expect((await list()).length).toBe(1);

    watchForSessionExpiry({ sweepIntervalMs: 60_000 });
    simulateSessionExpiryForTests();

    // The handler awaits the IDB clear; yield a couple of microtasks for
    // the async chain inside `wipeOutbox` to settle.
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(await list()).toEqual([]);
  });

  // P3C-02 — the same expiry event MUST wipe the drafts store too. The
  // observer dispatches both wipes in parallel (Promise.all), so the test
  // seeds one of each and asserts both are gone after the flush.
  it("an observed session-expiry event clears both the Outbox AND the drafts store", async () => {
    await enqueue({ endpoint: "/x", method: "POST", body: null });
    useDraftStore
      .getState()
      .setLogCallDraft("SP-1", "PA-1", { summary: "should be wiped" });
    expect((await list()).length).toBe(1);
    expect(useDraftStore.getState().logCall["SP-1:PA-1"]).toBeDefined();

    watchForSessionExpiry({ sweepIntervalMs: 60_000 });
    simulateSessionExpiryForTests();

    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(await list()).toEqual([]);
    expect(useDraftStore.getState().logCall).toEqual({});
    expect(useDraftStore.getState().activeSpecialistId).toBeNull();
  });

  it("the defensive sweep re-runs the wipe after expiry was observed", async () => {
    // Only fake setInterval — fake-indexeddb's internals use setTimeout for
    // task scheduling and will hang if we fake the world.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    watchForSessionExpiry({ sweepIntervalMs: 30_000 });

    simulateSessionExpiryForTests();
    for (let i = 0; i < 5; i++) await Promise.resolve();

    // Re-seed the Outbox to prove the defensive sweep wipes it even after
    // the initial wipe has already drained things — represents the "channel
    // event was observed, then a stale tab re-enqueued before logout
    // completed" scenario.
    await enqueue({ endpoint: "/x", method: "POST", body: null });
    expect((await list()).length).toBe(1);

    vi.advanceTimersByTime(30_000);
    for (let i = 0; i < 5; i++) await Promise.resolve();

    expect(await list()).toEqual([]);
  });
});
