// @vitest-environment happy-dom

// P3C-02 — `wipeDrafts()` empties both the persisted IDB layer AND the
// in-process Zustand slice (TR-OFFLINE-9 / ARC-30). The functional
// guarantee the spec demands is "no queued draft data remains after
// session expiry"; we verify both halves so an open sheet doesn't render
// stale text in memory after the disk wipe.

import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clear, get, set } from "idb-keyval";

import {
  resetMemoryStorageForTests,
  useDraftStore,
} from "../../../app/_lib/offline/drafts/store";
import { draftsKvStore, resetDraftsKvStoreForTests } from "../../../app/_lib/offline/drafts/kv";
import { wipeDrafts } from "../../../app/_lib/offline/drafts/wipe";
import { DRAFTS_PERSIST_KEY } from "../../../app/_lib/offline/drafts/types";

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

describe("wipeDrafts (TR-OFFLINE-9)", () => {
  it("clears the on-disk slice under the persist key", async () => {
    // Seed the IDB directly under the persist key so the test does not
    // depend on Zustand's async-flush timing. The functional guarantee
    // wipeDrafts() owes the spec is "drafts gone from disk" — we test
    // exactly that: a row under DRAFTS_PERSIST_KEY exists before wipe
    // and is absent after.
    await set(
      DRAFTS_PERSIST_KEY,
      JSON.stringify({ logCall: { "SP-1:PA-1": { summary: "to wipe" } } }),
      draftsKvStore(),
    );
    expect(
      await get<string>(DRAFTS_PERSIST_KEY, draftsKvStore()),
    ).toBeDefined();

    await wipeDrafts();

    expect(
      await get<string>(DRAFTS_PERSIST_KEY, draftsKvStore()),
    ).toBeUndefined();
  });

  it("clears the in-process Zustand slice across every surface", async () => {
    const store = useDraftStore.getState();
    store.setLogCallDraft("SP-1", "PA-1", { summary: "log" });
    store.setCreateBarrierDraft("SP-1", "PA-1", { type: "Housing" });
    store.setSmsComposeDraft("SP-1", "PA-1", { body: "sms" });
    store.setEmailComposeDraft("SP-1", "PA-1", { subject: "email" });
    store.setScheduleVisitDraft("SP-1", "PA-1", { visitType: "home" });

    await wipeDrafts();

    const after = useDraftStore.getState();
    expect(after.activeSpecialistId).toBeNull();
    expect(after.logCall).toEqual({});
    expect(after.createBarrier).toEqual({});
    expect(after.smsCompose).toEqual({});
    expect(after.emailCompose).toEqual({});
    expect(after.scheduleVisit).toEqual({});
  });

  it("leaves a fresh write working after wipe (singleton stays usable)", async () => {
    await set(DRAFTS_PERSIST_KEY, "stale", draftsKvStore());
    await wipeDrafts();
    // Mirrors the outbox.ts comment: "Subsequent enqueues reuse the same
    // (empty) store" — the singleton handle must survive clear() so the
    // next persist write does not throw InvalidStateError.
    await set(DRAFTS_PERSIST_KEY, "fresh", draftsKvStore());
    expect(await get<string>(DRAFTS_PERSIST_KEY, draftsKvStore())).toBe(
      "fresh",
    );
  });
});
