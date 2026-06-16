// @vitest-environment happy-dom

// P3C-02 — Direct round-trip on the idb-keyval StateStorage adapter
// (TR-OFFLINE-7b, BR-69). Confirms the persist layer's storage contract
// without the Zustand shell: a value written under a key is readable after
// the singleton handle is reset (proves IDB persistence, not in-memory).
//
// Mirrors `test/offline/outbox.test.ts` infrastructure (fake-indexeddb +
// happy-dom + manual `clear` to reset state between cases).

import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clear, get, set } from "idb-keyval";

import { draftsKvStore, resetDraftsKvStoreForTests } from "../../../app/_lib/offline/drafts/kv";

beforeEach(async () => {
  await clear(draftsKvStore());
});

afterEach(async () => {
  await clear(draftsKvStore());
  resetDraftsKvStoreForTests();
});

describe("drafts/kv adapter", () => {
  it("round-trips a JSON-serialized payload under a single key", async () => {
    const payload = JSON.stringify({ logCall: { "S1:P1": { summary: "hi" } } });
    await set("form-drafts-state", payload, draftsKvStore());

    const back = await get<string>("form-drafts-state", draftsKvStore());
    expect(back).toBe(payload);
  });

  it("survives a simulated reload by re-opening the same IDB database", async () => {
    const payload = JSON.stringify({ logCall: { "S1:P1": { summary: "hi" } } });
    await set("form-drafts-state", payload, draftsKvStore());

    // Drop the singleton handle so the next call re-opens IDB from scratch.
    // The underlying rows persist (TR-OFFLINE-3 / BR-69 — drafts persist
    // across reload on the tablet PWA surface).
    resetDraftsKvStoreForTests();

    const back = await get<string>("form-drafts-state", draftsKvStore());
    expect(back).toBe(payload);
  });

  it("uses a database name distinct from the Outbox so wipes do not cross", async () => {
    // Smoke check on the constant: this is the contract every wipe path
    // relies on. If someone collapses the two databases, both wipes would
    // collide and we'd lose the guarantee from the wipe-on-expiry test.
    const { DRAFTS_DB_NAME } = await import("../../../app/_lib/offline/drafts/types");
    const { OUTBOX_DB_NAME } = await import("../../../app/_lib/offline/types");
    expect(DRAFTS_DB_NAME).not.toBe(OUTBOX_DB_NAME);
  });
});
