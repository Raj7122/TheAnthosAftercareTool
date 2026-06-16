// @vitest-environment happy-dom

// P3C-02 — Surface-bifurcation gate (ADR-05; SAD v1.2 §6.5).
//
// On the tablet PWA surface (top-level origin) the draft store persists
// through `idb-keyval` so drafts survive reload. Inside the Salesforce
// Console iframe the same store API works but writes land in an in-memory
// Map so reload wipes the slate — AC #5 "desktop iframe surface drafts are
// session-only (no IndexedDB persistence)".
//
// We test the picker directly rather than instantiate Zustand; the picker
// IS the gate, and Zustand's persist orchestration belongs to Zustand.

import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { clear, get } from "idb-keyval";

import {
  pickDraftStateStorage,
  resetMemoryStorageForTests,
} from "../../../app/_lib/offline/drafts/store";
import { draftsKvStore, resetDraftsKvStoreForTests } from "../../../app/_lib/offline/drafts/kv";

afterEach(async () => {
  await clear(draftsKvStore());
  resetDraftsKvStoreForTests();
  resetMemoryStorageForTests();
  Object.defineProperty(window, "top", {
    configurable: true,
    value: window,
  });
});

describe("pickDraftStateStorage", () => {
  it("on the top-level surface, writes survive a simulated reload (IDB)", async () => {
    // happy-dom defaults to top-level (window.top === window). Writing via
    // the picked storage then resetting the kv singleton (simulating a
    // page reload — see outbox.test.ts "survives a simulated reload" case)
    // must still surface the value through a fresh adapter call. This is
    // the IDB-vs-memory discriminator: only IDB rows survive the reset.
    const storage = pickDraftStateStorage();
    await storage.setItem("k", "v-from-idb");

    resetDraftsKvStoreForTests();

    const reopened = pickDraftStateStorage();
    expect(await reopened.getItem("k")).toBe("v-from-idb");
  });

  it("on the iframe surface, writes do NOT survive a simulated reload (in-memory)", async () => {
    Object.defineProperty(window, "top", {
      configurable: true,
      value: { fake: true } as unknown as Window,
    });

    const storage = pickDraftStateStorage();
    await storage.setItem("k", "v-from-memory");

    // Simulating a reload on the iframe surface means BOTH the kv handle
    // and the in-memory map are gone — represents the tab discarding its
    // JS context. AC #5 evidence: drafts session-only on the iframe.
    resetDraftsKvStoreForTests();
    resetMemoryStorageForTests();

    const reopened = pickDraftStateStorage();
    expect(await reopened.getItem("k")).toBeNull();
    // And the IDB drafts database is untouched — the iframe surface NEVER
    // writes drafts to disk.
    expect(await get<string>("k", draftsKvStore())).toBeUndefined();
  });

  it("iframe in-memory adapter round-trips within a single page session", async () => {
    Object.defineProperty(window, "top", {
      configurable: true,
      value: { fake: true } as unknown as Window,
    });

    const storage = pickDraftStateStorage();
    await storage.setItem("k", "in-mem");
    // Same module instance, no reload simulated — value is readable; this
    // confirms the iframe surface still supports close→reopen survival
    // within a single tab session (the spec's "session-only" language).
    expect(await storage.getItem("k")).toBe("in-mem");
  });
});
