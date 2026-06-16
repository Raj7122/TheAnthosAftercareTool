// @vitest-environment happy-dom

// P3C-02 — `useDraftStoreSync` MUST wait for IDB rehydration before
// dispatching `syncActiveSpecialist`. Otherwise the "first adoption"
// branch runs against the empty initial slice, adopts the incoming id
// without purging, and then IDB rehydration restores the PREVIOUS
// specialist's drafts + their `activeSpecialistId` — leaking another
// specialist's draft text onto the wrong session (violates AC #4).
//
// This is the regression test for the code-review finding. We exercise
// the contract `useDraftStoreSync` relies on:
//   - When `persist.hasHydrated()` is false, the dispatch is deferred to
//     `persist.onFinishHydration`.
//   - When `persist.hasHydrated()` is true (subsequent in-session calls),
//     the dispatch runs synchronously.

import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clear } from "idb-keyval";

import {
  resetMemoryStorageForTests,
  useDraftStore,
} from "../../../app/_lib/offline/drafts/store";
import {
  draftsKvStore,
  resetDraftsKvStoreForTests,
} from "../../../app/_lib/offline/drafts/kv";

beforeEach(async () => {
  await clear(draftsKvStore());
  useDraftStore.getState().resetAllForTests();
  resetMemoryStorageForTests();
});

afterEach(async () => {
  await clear(draftsKvStore());
  useDraftStore.getState().resetAllForTests();
  resetMemoryStorageForTests();
  resetDraftsKvStoreForTests();
});

describe("persist hydration coordination (AC #4 leak guard)", () => {
  it("exposes hasHydrated() and onFinishHydration() on the persist handle", () => {
    // Smoke check on the API surface `useDraftStoreSync` depends on. If a
    // future Zustand upgrade renames or removes these, the hook silently
    // breaks and the leak comes back; this test is the trip-wire.
    expect(typeof useDraftStore.persist.hasHydrated).toBe("function");
    expect(typeof useDraftStore.persist.onFinishHydration).toBe("function");
  });

  it("after rehydrate(), hasHydrated() is true and syncActiveSpecialist purges correctly", async () => {
    // `rehydrate()` re-runs the persist read path; this models the "client
    // module just loaded, hydration just finished" state where
    // `useDraftStoreSync` should fire syncActiveSpecialist synchronously.
    await useDraftStore.persist.rehydrate();
    expect(useDraftStore.persist.hasHydrated()).toBe(true);

    // Seed a prior session by directly mutating the slice (the equivalent
    // of "IDB had this row before the new specialist mounted").
    useDraftStore.setState({
      activeSpecialistId: "SP-1",
      logCall: { "SP-1:PA-1": { summary: "previous specialist's draft" } },
      createBarrier: {},
      smsCompose: {},
      emailCompose: {},
      scheduleVisit: {},
    });

    // A different specialist signs in — the sync MUST purge.
    useDraftStore.getState().syncActiveSpecialist("SP-2");

    const after = useDraftStore.getState();
    expect(after.activeSpecialistId).toBe("SP-2");
    expect(after.logCall["SP-1:PA-1"]).toBeUndefined();
  });

  it("onFinishHydration fires the registered callback exactly once per hydration", async () => {
    let calls = 0;
    const unsubscribe = useDraftStore.persist.onFinishHydration(() => {
      calls += 1;
    });

    await useDraftStore.persist.rehydrate();
    expect(calls).toBe(1);

    unsubscribe();
    await useDraftStore.persist.rehydrate();
    // After unsubscribe, the listener is detached — the count stays at 1.
    expect(calls).toBe(1);
  });
});
