import type { StructuredLogger } from "@anthos/logging";
import { describe, expect, it, vi } from "vitest";

import type { IdempotentHandler } from "../../src/idempotency/middleware.js";
import { withIdempotency } from "../../src/idempotency/middleware.js";
import type {
  IdempotencyRecord,
  IdempotencyStatus,
  IdempotencyStore,
} from "../../src/idempotency/store.js";

// ── fixtures ───────────────────────────────────────────────────────────────

const KEY_A = "11111111-1111-4111-8111-111111111111";
const SPECIALIST_A = "S-100";
const SPECIALIST_B = "S-200";
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface FakeRow {
  key: string;
  specialistId: string;
  status: IdempotencyStatus;
  requestHash: string | null;
  responseStatusCode: number | null;
  responseBody: unknown;
  traceId: string | null;
  expiresAt: Date;
}

// In-memory IdempotencyStore. `acquire` mirrors `INSERT … ON CONFLICT DO
// NOTHING` — insert-and-return when the key is free, `null` when it exists.
function makeFakeStore(): { store: IdempotencyStore; rows: Map<string, FakeRow> } {
  const rows = new Map<string, FakeRow>();
  const store: IdempotencyStore = {
    acquire(input) {
      if (rows.has(input.key)) {
        return Promise.resolve(null);
      }
      const row: FakeRow = {
        key: input.key,
        specialistId: input.specialistId,
        status: "IN_FLIGHT",
        requestHash: input.requestHash,
        responseStatusCode: null,
        responseBody: null,
        traceId: input.traceId,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      };
      rows.set(input.key, row);
      return Promise.resolve({ ...row });
    },
    get(key) {
      const row = rows.get(key);
      return Promise.resolve(row ? ({ ...row } as IdempotencyRecord) : null);
    },
    markCompleted(key, code, body) {
      const row = rows.get(key);
      if (row) {
        row.status = "COMPLETED";
        row.responseStatusCode = code;
        row.responseBody = body;
      }
      return Promise.resolve();
    },
    markFailedTerminal(key, code, body) {
      const row = rows.get(key);
      if (row) {
        row.status = "FAILED_TERMINAL";
        row.responseStatusCode = code;
        row.responseBody = body;
      }
      return Promise.resolve();
    },
    delete(key) {
      rows.delete(key);
      return Promise.resolve();
    },
    cleanupExpired() {
      let deleted = 0;
      for (const [key, row] of rows) {
        if (row.expiresAt.getTime() < Date.now()) {
          rows.delete(key);
          deleted += 1;
        }
      }
      return Promise.resolve(deleted);
    },
  };
  return { store, rows };
}

function makeReq(
  opts: { key?: string; traceId?: string; body?: unknown; method?: string } = {},
): Request {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (opts.key !== undefined) {
    headers.set("Idempotency-Key", opts.key);
  }
  if (opts.traceId !== undefined) {
    headers.set("X-Trace-Id", opts.traceId);
  }
  return new Request("https://bff.test/api/calls", {
    method: opts.method ?? "POST",
    headers,
    body: JSON.stringify(opts.body ?? { x: 1 }),
  });
}

// A counting handler returning a fixed status + body.
function countingHandler(
  status: number,
  body: unknown,
): { handler: IdempotentHandler; calls: () => number } {
  let calls = 0;
  return {
    handler: () => {
      calls += 1;
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json" },
        }),
      );
    },
    calls: () => calls,
  };
}

// ── header validation ──────────────────────────────────────────────────────

describe("withIdempotency — header validation", () => {
  it("rejects a missing Idempotency-Key with 400 IDEMPOTENCY_KEY_REQUIRED", async () => {
    const { store } = makeFakeStore();
    const { handler, calls } = countingHandler(201, { ok: true });
    const res = await withIdempotency(handler, { store })(makeReq(), {
      specialistId: SPECIALIST_A,
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toMatchObject({ code: "IDEMPOTENCY_KEY_REQUIRED" });
    expect(calls()).toBe(0);
  });

  it("rejects a non-UUIDv4 key with 400 IDEMPOTENCY_KEY_INVALID", async () => {
    const { store } = makeFakeStore();
    const { handler, calls } = countingHandler(201, { ok: true });
    const res = await withIdempotency(handler, { store })(
      makeReq({ key: "not-a-uuid" }),
      { specialistId: SPECIALIST_A },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "IDEMPOTENCY_KEY_INVALID" });
    expect(calls()).toBe(0);
  });
});

// ── state machine: first execution + replay ────────────────────────────────

describe("withIdempotency — COMPLETED path", () => {
  it("runs the handler on a fresh key and caches a COMPLETED row", async () => {
    const { store, rows } = makeFakeStore();
    const { handler } = countingHandler(201, { id: "call-1" });
    const res = await withIdempotency(handler, { store })(makeReq({ key: KEY_A }), {
      specialistId: SPECIALIST_A,
    });
    expect(res.status).toBe(201);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({ id: "call-1" });
    const row = rows.get(KEY_A);
    expect(row?.status).toBe("COMPLETED");
    expect(row?.responseStatusCode).toBe(201);
    expect(row?.responseBody).toEqual({ id: "call-1" });
  });

  it("returns the cached response on replay WITHOUT re-running the handler", async () => {
    const { store } = makeFakeStore();
    const { handler, calls } = countingHandler(201, { id: "call-1" });
    const wrapped = withIdempotency(handler, { store });
    await wrapped(makeReq({ key: KEY_A }), { specialistId: SPECIALIST_A });
    const replay = await wrapped(makeReq({ key: KEY_A }), {
      specialistId: SPECIALIST_A,
    });
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual({ id: "call-1" });
    expect(replay.headers.get("X-Idempotent-Replay")).toBe("true");
    expect(calls()).toBe(1);
  });
});

// ── state machine: 4xx is terminal ─────────────────────────────────────────

describe("withIdempotency — FAILED_TERMINAL path", () => {
  it("marks a 4xx response FAILED_TERMINAL and replays the cached failure without retry", async () => {
    const { store, rows } = makeFakeStore();
    const { handler, calls } = countingHandler(422, { code: "VALIDATION_FAILED" });
    const wrapped = withIdempotency(handler, { store });

    const first = await wrapped(makeReq({ key: KEY_A }), {
      specialistId: SPECIALIST_A,
    });
    expect(first.status).toBe(422);
    expect(rows.get(KEY_A)?.status).toBe("FAILED_TERMINAL");

    const replay = await wrapped(makeReq({ key: KEY_A }), {
      specialistId: SPECIALIST_A,
    });
    expect(replay.status).toBe(422);
    expect(replay.headers.get("X-Idempotent-Replay")).toBe("true");
    expect(await replay.json()).toEqual({ code: "VALIDATION_FAILED" });
    expect(calls()).toBe(1);
  });
});

// ── state machine: 5xx and thrown errors release the lock ──────────────────

describe("withIdempotency — lock release", () => {
  it("deletes the key on a 5xx response so the request can be retried", async () => {
    const { store, rows } = makeFakeStore();
    const fail = countingHandler(503, { code: "SF_UPSTREAM_UNAVAILABLE" });
    const ok = countingHandler(201, { id: "call-1" });

    const failed = await withIdempotency(fail.handler, { store })(
      makeReq({ key: KEY_A }),
      { specialistId: SPECIALIST_A },
    );
    expect(failed.status).toBe(503);
    expect(rows.has(KEY_A)).toBe(false);

    const retry = await withIdempotency(ok.handler, { store })(
      makeReq({ key: KEY_A }),
      { specialistId: SPECIALIST_A },
    );
    expect(retry.status).toBe(201);
    expect(ok.calls()).toBe(1);
  });

  it("deletes the key and re-throws when the handler throws", async () => {
    const { store, rows } = makeFakeStore();
    const throwing: IdempotentHandler = () => Promise.reject(new Error("boom"));
    await expect(
      withIdempotency(throwing, { store })(makeReq({ key: KEY_A }), {
        specialistId: SPECIALIST_A,
      }),
    ).rejects.toThrow("boom");
    expect(rows.has(KEY_A)).toBe(false);
  });
});

// ── concurrency: atomic lock ───────────────────────────────────────────────

describe("withIdempotency — atomic lock", () => {
  it("resolves concurrent same-key requests to one execution and one 409", async () => {
    const { store } = makeFakeStore();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let runs = 0;
    const handler: IdempotentHandler = async () => {
      runs += 1;
      await gate;
      return new Response(JSON.stringify({ id: "call-1" }), { status: 201 });
    };
    const wrapped = withIdempotency(handler, { store });

    const first = wrapped(makeReq({ key: KEY_A }), { specialistId: SPECIALIST_A });
    const second = wrapped(makeReq({ key: KEY_A }), { specialistId: SPECIALIST_A });

    const secondRes = await second;
    expect(secondRes.status).toBe(409);
    expect(await secondRes.json()).toMatchObject({ code: "IDEMPOTENCY_IN_FLIGHT" });

    release();
    const firstRes = await first;
    expect(firstRes.status).toBe(201);
    expect(runs).toBe(1);
  });

  it("returns 409 when the lock can be neither acquired nor resolved", async () => {
    // Degenerate store: acquire always loses and the row is never visible —
    // both retry attempts exhaust and the middleware falls back to 409.
    const phantomStore: IdempotencyStore = {
      acquire: () => Promise.resolve(null),
      get: () => Promise.resolve(null),
      markCompleted: () => Promise.resolve(),
      markFailedTerminal: () => Promise.resolve(),
      delete: () => Promise.resolve(),
      cleanupExpired: () => Promise.resolve(0),
    };
    const { handler, calls } = countingHandler(201, { ok: true });
    const res = await withIdempotency(handler, { store: phantomStore })(
      makeReq({ key: KEY_A }),
      { specialistId: SPECIALIST_A },
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "IDEMPOTENCY_IN_FLIGHT" });
    expect(calls()).toBe(0);
  });
});

// ── cross-specialist isolation ─────────────────────────────────────────────

describe("withIdempotency — cross-specialist isolation", () => {
  it("never returns one specialist's cached response to another", async () => {
    const { store } = makeFakeStore();
    const owner = countingHandler(201, { id: "owned-by-A" });
    const intruder = countingHandler(201, { id: "owned-by-B" });

    await withIdempotency(owner.handler, { store })(makeReq({ key: KEY_A }), {
      specialistId: SPECIALIST_A,
    });
    const res = await withIdempotency(intruder.handler, { store })(
      makeReq({ key: KEY_A }),
      { specialistId: SPECIALIST_B },
    );
    expect(res.status).toBe(409);
    const body = await res.text();
    expect(body).not.toContain("owned-by-A");
    expect(intruder.calls()).toBe(0);
  });
});

// ── request-hash binding ───────────────────────────────────────────────────

describe("withIdempotency — request-hash binding", () => {
  it("rejects a key replayed with a different body (422)", async () => {
    const { store } = makeFakeStore();
    const { handler } = countingHandler(201, { id: "call-1" });
    const wrapped = withIdempotency(handler, { store });

    await wrapped(makeReq({ key: KEY_A, body: { amount: 1 } }), {
      specialistId: SPECIALIST_A,
    });
    const res = await wrapped(makeReq({ key: KEY_A, body: { amount: 999 } }), {
      specialistId: SPECIALIST_A,
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      code: "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD",
    });
  });

  it("replays normally when the key is reused with an identical body", async () => {
    const { store } = makeFakeStore();
    const { handler, calls } = countingHandler(201, { id: "call-1" });
    const wrapped = withIdempotency(handler, { store });

    await wrapped(makeReq({ key: KEY_A, body: { amount: 1 } }), {
      specialistId: SPECIALIST_A,
    });
    const res = await wrapped(makeReq({ key: KEY_A, body: { amount: 1 } }), {
      specialistId: SPECIALIST_A,
    });
    expect(res.status).toBe(201);
    expect(res.headers.get("X-Idempotent-Replay")).toBe("true");
    expect(calls()).toBe(1);
  });

  it("replays a COMPLETED row with a null request hash instead of returning 422", async () => {
    const { store, rows } = makeFakeStore();
    rows.set(KEY_A, {
      key: KEY_A,
      specialistId: SPECIALIST_A,
      status: "COMPLETED",
      requestHash: null,
      responseStatusCode: 200,
      responseBody: { id: "legacy" },
      traceId: "old-trace",
      expiresAt: new Date(Date.now() + 60 * 1000),
    });
    const { handler, calls } = countingHandler(201, { id: "fresh" });
    const res = await withIdempotency(handler, { store })(makeReq({ key: KEY_A }), {
      specialistId: SPECIALIST_A,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Idempotent-Replay")).toBe("true");
    expect(await res.json()).toEqual({ id: "legacy" });
    expect(calls()).toBe(0);
  });
});

// ── trace_id propagation ───────────────────────────────────────────────────

describe("withIdempotency — trace_id", () => {
  it("reads X-Trace-Id from the request, stores it, and echoes it", async () => {
    const { store, rows } = makeFakeStore();
    const { handler } = countingHandler(201, { ok: true });
    const res = await withIdempotency(handler, { store })(
      makeReq({ key: KEY_A, traceId: "trace-xyz-1" }),
      { specialistId: SPECIALIST_A },
    );
    expect(res.headers.get("X-Trace-Id")).toBe("trace-xyz-1");
    expect(rows.get(KEY_A)?.traceId).toBe("trace-xyz-1");
  });

  it("generates a trace id when the request omits X-Trace-Id", async () => {
    const { store, rows } = makeFakeStore();
    const { handler } = countingHandler(201, { ok: true });
    const res = await withIdempotency(handler, { store })(makeReq({ key: KEY_A }), {
      specialistId: SPECIALIST_A,
    });
    const echoed = res.headers.get("X-Trace-Id");
    expect(echoed).toMatch(UUID_RE);
    expect(rows.get(KEY_A)?.traceId).toBe(echoed);
  });
});

// ── rejection logging (P1A-06) ─────────────────────────────────────────────

describe("withIdempotency — rejection logging", () => {
  it("emits a structured request-hash-mismatch event carrying trace_id", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { store } = makeFakeStore();
    const { handler } = countingHandler(201, { id: "call-1" });
    const wrapped = withIdempotency(handler, { store });

    await wrapped(makeReq({ key: KEY_A, traceId: "trace-mm", body: { a: 1 } }), {
      specialistId: SPECIALIST_A,
    });
    const res = await wrapped(
      makeReq({ key: KEY_A, traceId: "trace-mm", body: { a: 2 } }),
      { specialistId: SPECIALIST_A },
    );
    expect(res.status).toBe(422);

    const record = JSON.parse(String(warn.mock.calls.at(-1)?.[0]));
    expect(record.event).toBe("idempotency_request_hash_mismatch");
    expect(record.trace_id).toBe("trace-mm");
    expect(record.specialist_id).toBe(SPECIALIST_A);
    expect(record.module).toBe("api.idempotency");
    expect(record.level).toBe("warn");
    warn.mockRestore();
  });

  it("logs a cross-specialist collision without leaking the full idempotency key", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { store } = makeFakeStore();
    const owner = countingHandler(201, { id: "owned-by-A" });
    const intruder = countingHandler(201, { id: "owned-by-B" });

    await withIdempotency(owner.handler, { store })(makeReq({ key: KEY_A }), {
      specialistId: SPECIALIST_A,
    });
    await withIdempotency(intruder.handler, { store })(makeReq({ key: KEY_A }), {
      specialistId: SPECIALIST_B,
    });

    const record = JSON.parse(String(warn.mock.calls.at(-1)?.[0]));
    expect(record.event).toBe("idempotency_cross_specialist_collision");
    expect(record.idempotency_key_prefix).toBe(KEY_A.slice(0, 8));
    // The full client-generated key is never written to the log stream.
    expect(String(warn.mock.calls)).not.toContain(KEY_A);
    warn.mockRestore();
  });

  it("routes rejection events through an injected logger", async () => {
    const events: string[] = [];
    const recorder: StructuredLogger = {
      debug: () => undefined,
      info: () => undefined,
      warn: (_message, fields = {}) => {
        events.push(String(fields.event));
      },
      error: () => undefined,
      child: () => recorder,
    };
    const { store } = makeFakeStore();
    const { handler } = countingHandler(201, { id: "call-1" });
    const wrapped = withIdempotency(handler, { store, logger: recorder });

    await wrapped(makeReq({ key: KEY_A, body: { a: 1 } }), {
      specialistId: SPECIALIST_A,
    });
    await wrapped(makeReq({ key: KEY_A, body: { a: 2 } }), {
      specialistId: SPECIALIST_A,
    });
    expect(events).toEqual(["idempotency_request_hash_mismatch"]);
  });
});

// ── TTL expiry ─────────────────────────────────────────────────────────────

describe("withIdempotency — TTL expiry", () => {
  it("treats an expired row as absent and re-runs the handler", async () => {
    const { store, rows } = makeFakeStore();
    rows.set(KEY_A, {
      key: KEY_A,
      specialistId: SPECIALIST_A,
      status: "COMPLETED",
      requestHash: "stale-hash",
      responseStatusCode: 201,
      responseBody: { id: "stale" },
      traceId: "old-trace",
      expiresAt: new Date(Date.now() - 60 * 1000),
    });
    const { handler, calls } = countingHandler(201, { id: "fresh" });
    const res = await withIdempotency(handler, { store })(makeReq({ key: KEY_A }), {
      specialistId: SPECIALIST_A,
    });
    expect(res.status).toBe(201);
    expect(res.headers.get("X-Idempotent-Replay")).toBeNull();
    expect(await res.json()).toEqual({ id: "fresh" });
    expect(calls()).toBe(1);
  });
});
