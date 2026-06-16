// @vitest-environment happy-dom

// P3C-13 — page-side `replayOutbox()` behavior: it re-sends each queued row
// with its STORED idempotency key (Pattern D), removes on 2xx, stops on a
// network failure (still offline), and never races itself (inFlight guard).

import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearAll,
  enqueue,
  list,
  resetOutboxStoreForTests,
} from "../../app/_lib/offline/outbox";
import {
  replayOutbox,
  resetReplayStateForTests,
} from "../../app/_lib/offline/replay";

function okResponse(): Response {
  // `sendOne` only reads `res.ok`; a minimal stand-in avoids constructing a
  // full Response in the test environment.
  return { ok: true, status: 200 } as Response;
}

beforeEach(async () => {
  await clearAll();
  resetReplayStateForTests();
});

afterEach(async () => {
  await clearAll();
  resetOutboxStoreForTests();
  resetReplayStateForTests();
});

describe("replayOutbox", () => {
  it("re-POSTs each row with its stored idempotency key", async () => {
    await enqueue({
      endpoint: "/api/v1/participants/abc/calls",
      method: "POST",
      body: { status: "Completed" },
      idempotencyKey: "stored-key-1",
    });
    const fetchImpl = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
        okResponse(),
    );

    await replayOutbox({ fetchImpl, schedule: (cb) => cb() });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const call = fetchImpl.mock.calls[0]!;
    const url = call[0];
    const init = call[1]!;
    expect(url).toBe("/api/v1/participants/abc/calls");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBe("stored-key-1");
  });

  it("re-POSTs a queued case-note row with its stored key (P3C-14)", async () => {
    await enqueue({
      endpoint: "/api/v1/participants/p-9/case-notes",
      method: "POST",
      body: { note: "Quarterly check", contactType: "Phone", type: "Check In", status: "Completed" },
      idempotencyKey: "cn-key-1",
    });
    const fetchImpl = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
        okResponse(),
    );

    await replayOutbox({ fetchImpl, flashMs: 0, schedule: (cb) => cb() });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const call = fetchImpl.mock.calls[0]!;
    expect(call[0]).toBe("/api/v1/participants/p-9/case-notes");
    const headers = call[1]!.headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBe("cn-key-1");
    // Confirmed 2xx clears it from the Outbox.
    expect(await list()).toEqual([]);
  });

  it("removes a row from the Outbox on a 2xx", async () => {
    await enqueue({
      endpoint: "/api/v1/x/1",
      method: "POST",
      body: null,
      idempotencyKey: "k-1",
    });
    const fetchImpl = vi.fn(async () => okResponse());

    await replayOutbox({ fetchImpl, flashMs: 0, schedule: (cb) => cb() });

    expect(await list()).toEqual([]);
  });

  it("leaves the row queued and stops on a network error", async () => {
    await enqueue({
      endpoint: "/api/v1/x/1",
      method: "POST",
      body: null,
      idempotencyKey: "k-1",
    });
    await enqueue({
      endpoint: "/api/v1/x/2",
      method: "POST",
      body: null,
      idempotencyKey: "k-2",
    });
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });

    await replayOutbox({ fetchImpl, schedule: (cb) => cb() });

    // First row errored → stop; both rows remain queued for the next attempt.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((await list()).map((r) => r.id).sort()).toEqual(["k-1", "k-2"]);
  });

  it("does not race itself — concurrent calls collapse to one drain", async () => {
    await enqueue({
      endpoint: "/api/v1/x/1",
      method: "POST",
      body: null,
      idempotencyKey: "k-1",
    });
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchImpl = vi.fn(async () => {
      await gate;
      return okResponse();
    });

    const first = replayOutbox({ fetchImpl, schedule: (cb) => cb() });
    // Second call arrives while the first is mid-flight → inFlight guard.
    const second = replayOutbox({ fetchImpl, schedule: (cb) => cb() });
    release();
    await Promise.all([first, second]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
