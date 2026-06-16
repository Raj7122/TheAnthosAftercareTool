// @vitest-environment happy-dom

// P3C-02 — Zustand draft store: per-specialist scoping (AC #4) + per-
// (specialist, participant) key isolation + the syncActiveSpecialist purge.
// Storage layer is exercised here transitively; round-trip fidelity is
// covered by `adapter.test.ts`.

import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clear } from "idb-keyval";

import {
  resetMemoryStorageForTests,
  useDraftStore,
} from "../../../app/_lib/offline/drafts/store";
import { draftsKvStore, resetDraftsKvStoreForTests } from "../../../app/_lib/offline/drafts/kv";

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

describe("drafts/store — per-(specialist, participant) isolation", () => {
  it("keeps two specialists' drafts on the same participant id distinct", () => {
    const store = useDraftStore.getState();
    store.setLogCallDraft("SP-1", "PA-1", { summary: "from one" });
    store.setLogCallDraft("SP-2", "PA-1", { summary: "from two" });

    const after = useDraftStore.getState().logCall;
    expect(after["SP-1:PA-1"]?.summary).toBe("from one");
    expect(after["SP-2:PA-1"]?.summary).toBe("from two");
  });

  it("keeps the same specialist's drafts for two participants distinct", () => {
    const store = useDraftStore.getState();
    store.setCreateBarrierDraft("SP-1", "PA-A", { type: "Housing" });
    store.setCreateBarrierDraft("SP-1", "PA-B", { type: "Income" });

    const after = useDraftStore.getState().createBarrier;
    expect(after["SP-1:PA-A"]?.type).toBe("Housing");
    expect(after["SP-1:PA-B"]?.type).toBe("Income");
  });

  it("clear<Surface>Draft removes only the targeted scope key", () => {
    const store = useDraftStore.getState();
    store.setLogCallDraft("SP-1", "PA-A", { summary: "keep" });
    store.setLogCallDraft("SP-1", "PA-B", { summary: "drop" });

    store.clearLogCallDraft("SP-1", "PA-B");
    const after = useDraftStore.getState().logCall;
    expect(after["SP-1:PA-A"]?.summary).toBe("keep");
    expect(after["SP-1:PA-B"]).toBeUndefined();
  });
});

describe("drafts/store — syncActiveSpecialist purge (AC #4)", () => {
  it("adopts the first-seen specialist id without dropping anything", () => {
    const store = useDraftStore.getState();
    store.setLogCallDraft("SP-1", "PA-1", { summary: "fresh tab" });
    // activeSpecialistId starts null; the first sync adopts the value rather
    // than wiping the drafts the same session just wrote.
    store.syncActiveSpecialist("SP-1");

    const after = useDraftStore.getState();
    expect(after.activeSpecialistId).toBe("SP-1");
    expect(after.logCall["SP-1:PA-1"]?.summary).toBe("fresh tab");
  });

  it("purges every surface map when the specialist id changes", () => {
    const store = useDraftStore.getState();
    store.syncActiveSpecialist("SP-1");
    store.setLogCallDraft("SP-1", "PA-1", { summary: "log-call draft" });
    store.setCreateBarrierDraft("SP-1", "PA-2", { type: "Housing" });
    store.setSmsComposeDraft("SP-1", "PA-3", { body: "sms" });
    store.setEmailComposeDraft("SP-1", "PA-4", { subject: "email" });
    store.setScheduleVisitDraft("SP-1", "PA-5", { visitType: "home" });

    store.syncActiveSpecialist("SP-2");

    const after = useDraftStore.getState();
    expect(after.activeSpecialistId).toBe("SP-2");
    expect(after.logCall).toEqual({});
    expect(after.createBarrier).toEqual({});
    expect(after.smsCompose).toEqual({});
    expect(after.emailCompose).toEqual({});
    expect(after.scheduleVisit).toEqual({});
  });

  it("is a no-op when the incoming id already matches activeSpecialistId", () => {
    const store = useDraftStore.getState();
    store.syncActiveSpecialist("SP-1");
    store.setLogCallDraft("SP-1", "PA-1", { summary: "keep me" });

    store.syncActiveSpecialist("SP-1");

    expect(useDraftStore.getState().logCall["SP-1:PA-1"]?.summary).toBe(
      "keep me",
    );
  });

  // First-adoption-with-existing-drafts: a brand-new tab can legitimately
  // have draft text in-memory before `useDraftStoreSync` resolves the
  // session identity (e.g., the sheet mirror-effect wrote a draft while
  // /me was still in flight). On the first adoption we MUST preserve those
  // drafts — discarding them would be a UX regression for the common case
  // of "open the app, start typing, then /me lands".
  it("first-adoption with existing in-memory drafts: preserves the drafts", () => {
    const store = useDraftStore.getState();
    // No prior syncActiveSpecialist call — activeSpecialistId starts null
    // by design (the initial persisted state has null).
    expect(useDraftStore.getState().activeSpecialistId).toBeNull();
    store.setLogCallDraft("SP-1", "PA-1", { summary: "typed before /me" });

    store.syncActiveSpecialist("SP-1");

    const after = useDraftStore.getState();
    expect(after.activeSpecialistId).toBe("SP-1");
    expect(after.logCall["SP-1:PA-1"]?.summary).toBe("typed before /me");
  });
});

describe("drafts/store — patch merging", () => {
  it("setLogCallDraft merges incoming fields onto an existing draft", () => {
    const store = useDraftStore.getState();
    store.setLogCallDraft("SP-1", "PA-1", {
      status: "Attempted",
      summary: "first pass",
    });
    store.setLogCallDraft("SP-1", "PA-1", { summary: "second pass" });

    const after = useDraftStore.getState().logCall["SP-1:PA-1"];
    expect(after?.status).toBe("Attempted");
    expect(after?.summary).toBe("second pass");
  });
});
