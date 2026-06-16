import { hashToken, loadSessionConfig, mintToken } from "@anthos/auth";
import type { Role } from "@anthos/auth";
import { describe, expect, it, vi } from "vitest";

import type { IdempotentHandler, IdempotentRequestContext } from "../../src/idempotency/middleware.js";
import { withIdempotency } from "../../src/idempotency/middleware.js";
import type { IdempotencyRecord, IdempotencyStore } from "../../src/idempotency/store.js";
import { withSession } from "../../src/session/middleware.js";
import type { SessionHandler, SessionRequestContext } from "../../src/session/middleware.js";
import type { SessionRecord, SessionStore } from "../../src/session/store.js";

// ── fixtures ───────────────────────────────────────────────────────────────

const CONFIG = loadSessionConfig({}); // 30-min idle, 12-h absolute
const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface FakeSession {
  id: string;
  specialistId: string;
  role: Role;
  lastActivityAt: Date;
  expiresAt: Date;
  revoked: boolean;
}

function toRecord(s: FakeSession): SessionRecord {
  return {
    id: s.id,
    specialistId: s.specialistId,
    role: s.role,
    lastActivityAt: s.lastActivityAt,
    expiresAt: s.expiresAt,
    revoked: s.revoked,
    displayName: null,
    email: null,
    timezone: null,
  };
}

// In-memory SessionStore keyed by token hash — no live Postgres.
function makeFakeStore(): {
  store: SessionStore;
  rows: Map<string, FakeSession>;
  touched: string[];
} {
  const rows = new Map<string, FakeSession>();
  const touched: string[] = [];
  const store: SessionStore = {
    create(input) {
      const row: FakeSession = {
        id: `session-${rows.size + 1}`,
        specialistId: input.specialistId,
        role: input.role,
        lastActivityAt: new Date(),
        expiresAt: input.expiresAt,
        revoked: false,
      };
      rows.set(input.tokenHash, row);
      return Promise.resolve(toRecord(row));
    },
    getByTokenHash(tokenHash) {
      const row = rows.get(tokenHash);
      return Promise.resolve(row ? toRecord(row) : null);
    },
    getSalesforceRefreshToken() {
      return Promise.resolve(null);
    },
    touch(tokenHash, now) {
      touched.push(tokenHash);
      const row = rows.get(tokenHash);
      if (row) {
        row.lastActivityAt = now;
      }
      return Promise.resolve();
    },
    applySessionRefresh(tokenHash, now) {
      const row = rows.get(tokenHash);
      if (row) {
        row.lastActivityAt = now;
      }
      return Promise.resolve();
    },
    revoke(tokenHash) {
      const row = rows.get(tokenHash);
      if (row) {
        row.revoked = true;
      }
      return Promise.resolve();
    },
    cleanupExpired() {
      return Promise.resolve(0);
    },
  };
  return { store, rows, touched };
}

// Seed a session row directly (full control of its timestamps) and return the
// plaintext cookie token that resolves to it.
function seed(
  rows: Map<string, FakeSession>,
  opts: {
    lastActivityAt?: Date;
    expiresAt?: Date;
    revoked?: boolean;
    specialistId?: string;
    role?: Role;
  } = {},
): string {
  const token = mintToken();
  rows.set(hashToken(token), {
    id: `session-${rows.size + 1}`,
    specialistId: opts.specialistId ?? "0058K00000XYZAbQAO",
    role: opts.role ?? "SPECIALIST",
    lastActivityAt: opts.lastActivityAt ?? new Date(),
    expiresAt: opts.expiresAt ?? new Date(Date.now() + 11 * HOUR),
    revoked: opts.revoked ?? false,
  });
  return token;
}

function makeReq(opts: { token?: string; traceId?: string } = {}): Request {
  const headers = new Headers();
  if (opts.token !== undefined) {
    headers.set("Cookie", `anthos_session=${opts.token}`);
  }
  if (opts.traceId !== undefined) {
    headers.set("X-Trace-Id", opts.traceId);
  }
  return new Request("https://bff.test/api/caseload", { method: "GET", headers });
}

function okHandler(): SessionHandler {
  return () => Promise.resolve(new Response("ok", { status: 200 }));
}

// Handler that records the context it was invoked with.
function capturingHandler(): {
  handler: SessionHandler;
  received: () => SessionRequestContext | undefined;
} {
  let received: SessionRequestContext | undefined;
  return {
    handler: (_req, ctx) => {
      received = ctx;
      return Promise.resolve(new Response("ok", { status: 200 }));
    },
    received: () => received,
  };
}

// ── 401: no / unknown session ──────────────────────────────────────────────

describe("withSession — rejects an absent or unknown session", () => {
  it("401 AUTH_SESSION_INVALID when no cookie is present", async () => {
    const { store } = makeFakeStore();
    const res = await withSession(okHandler(), { store, config: CONFIG })(makeReq());
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: "AUTH_SESSION_INVALID" });
  });

  it("401 AUTH_SESSION_INVALID when the cookie token matches no session", async () => {
    const { store } = makeFakeStore();
    const res = await withSession(okHandler(), { store, config: CONFIG })(
      makeReq({ token: mintToken() }),
    );
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("AUTH_SESSION_INVALID");
  });
});

// ── 401: timeout + revocation ──────────────────────────────────────────────

describe("withSession — enforces the timeout + revocation clocks", () => {
  it("401 AUTH_SESSION_EXPIRED with details.expiredAt on idle timeout", async () => {
    const { store, rows } = makeFakeStore();
    const token = seed(rows, { lastActivityAt: new Date(Date.now() - 31 * MINUTE) });
    const res = await withSession(okHandler(), { store, config: CONFIG })(
      makeReq({ token }),
    );
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("AUTH_SESSION_EXPIRED");
    expect(typeof body.details.expiredAt).toBe("string");
  });

  it("401 AUTH_SESSION_EXPIRED on absolute timeout", async () => {
    const { store, rows } = makeFakeStore();
    const token = seed(rows, { expiresAt: new Date(Date.now() - 1000) });
    const res = await withSession(okHandler(), { store, config: CONFIG })(
      makeReq({ token }),
    );
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("AUTH_SESSION_EXPIRED");
  });

  it("401 AUTH_SESSION_INVALID when the session is revoked", async () => {
    const { store, rows } = makeFakeStore();
    const token = seed(rows, { revoked: true });
    const res = await withSession(okHandler(), { store, config: CONFIG })(
      makeReq({ token }),
    );
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("AUTH_SESSION_INVALID");
  });
});

// ── active session ─────────────────────────────────────────────────────────

describe("withSession — admits an active session", () => {
  it("runs the handler with a populated SessionRequestContext", async () => {
    const { store, rows } = makeFakeStore();
    const token = seed(rows, { specialistId: "S-100", role: "SUPERVISOR" });
    const cap = capturingHandler();
    const res = await withSession(cap.handler, { store, config: CONFIG })(
      makeReq({ token }),
    );
    expect(res.status).toBe(200);
    const ctx = cap.received();
    expect(ctx?.specialistId).toBe("S-100");
    expect(ctx?.role).toBe("SUPERVISOR");
    expect(ctx?.sessionId).toBeDefined();
    expect(ctx?.traceId).toBeDefined();
  });

  it("heartbeats last_activity_at once for an active request", async () => {
    const { store, rows, touched } = makeFakeStore();
    const token = seed(rows);
    await withSession(okHandler(), { store, config: CONFIG })(makeReq({ token }));
    expect(touched).toHaveLength(1);
  });

  it("does NOT heartbeat an expired or revoked session", async () => {
    const { store, rows, touched } = makeFakeStore();
    const expired = seed(rows, { expiresAt: new Date(Date.now() - 1000) });
    const revoked = seed(rows, { revoked: true });
    await withSession(okHandler(), { store, config: CONFIG })(makeReq({ token: expired }));
    await withSession(okHandler(), { store, config: CONFIG })(makeReq({ token: revoked }));
    expect(touched).toHaveLength(0);
  });
});

// ── trace_id propagation (API §8.5) ────────────────────────────────────────

describe("withSession — trace_id propagation", () => {
  it("echoes an inbound X-Trace-Id into the context and the response", async () => {
    const { store, rows } = makeFakeStore();
    const token = seed(rows);
    const cap = capturingHandler();
    const res = await withSession(cap.handler, { store, config: CONFIG })(
      makeReq({ token, traceId: "trace-inbound-1" }),
    );
    expect(cap.received()?.traceId).toBe("trace-inbound-1");
    expect(res.headers.get("X-Trace-Id")).toBe("trace-inbound-1");
  });

  it("generates one consistent UUID trace_id when none is supplied", async () => {
    const { store, rows } = makeFakeStore();
    const token = seed(rows);
    const cap = capturingHandler();
    const res = await withSession(cap.handler, { store, config: CONFIG })(
      makeReq({ token }),
    );
    const headerTrace = res.headers.get("X-Trace-Id");
    expect(headerTrace).toMatch(UUID_RE);
    expect(cap.received()?.traceId).toBe(headerTrace);
  });

  it("stamps a generated trace_id on a 401 response too", async () => {
    const { store } = makeFakeStore();
    const res = await withSession(okHandler(), { store, config: CONFIG })(makeReq());
    expect(res.headers.get("X-Trace-Id")).toMatch(UUID_RE);
  });
});

// ── no raw token in logs (pii-firewall) ────────────────────────────────────

describe("withSession — never logs the raw cookie token", () => {
  it("keeps the plaintext token out of every rejection log line", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { store, rows } = makeFakeStore();
    const unknown = mintToken();
    const expired = seed(rows, { expiresAt: new Date(Date.now() - 1000) });
    const revoked = seed(rows, { revoked: true });

    const run = withSession(okHandler(), { store, config: CONFIG });
    await run(makeReq());
    await run(makeReq({ token: unknown }));
    await run(makeReq({ token: expired }));
    await run(makeReq({ token: revoked }));

    const logged = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(warn).toHaveBeenCalled();
    for (const token of [unknown, expired, revoked]) {
      expect(logged).not.toContain(token);
    }
    warn.mockRestore();
  });
});

// ── composition with withIdempotency ───────────────────────────────────────

function makeFakeIdempotencyStore(): IdempotencyStore {
  const rows = new Map<string, IdempotencyRecord>();
  return {
    acquire(input) {
      if (rows.has(input.key)) {
        return Promise.resolve(null);
      }
      const record: IdempotencyRecord = {
        key: input.key,
        specialistId: input.specialistId,
        status: "IN_FLIGHT",
        requestHash: input.requestHash,
        responseStatusCode: null,
        responseBody: null,
        traceId: input.traceId,
        expiresAt: new Date(Date.now() + 24 * HOUR),
      };
      rows.set(input.key, record);
      return Promise.resolve({ ...record });
    },
    get(key) {
      const row = rows.get(key);
      return Promise.resolve(row ? { ...row } : null);
    },
    markCompleted(key, code, body) {
      const row = rows.get(key);
      if (row) {
        rows.set(key, { ...row, status: "COMPLETED", responseStatusCode: code, responseBody: body });
      }
      return Promise.resolve();
    },
    markFailedTerminal(key, code, body) {
      const row = rows.get(key);
      if (row) {
        rows.set(key, { ...row, status: "FAILED_TERMINAL", responseStatusCode: code, responseBody: body });
      }
      return Promise.resolve();
    },
    delete(key) {
      rows.delete(key);
      return Promise.resolve();
    },
    cleanupExpired() {
      return Promise.resolve(0);
    },
  };
}

describe("withSession ∘ withIdempotency composition", () => {
  it("flows specialistId from the session and shares one trace_id", async () => {
    const { store, rows } = makeFakeStore();
    const token = seed(rows, { specialistId: "S-COMPOSED" });
    let received: IdempotentRequestContext | undefined;
    const inner: IdempotentHandler = (_req, ctx) => {
      received = ctx;
      return Promise.resolve(
        new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }),
      );
    };
    const composed = withSession(
      withIdempotency(inner, { store: makeFakeIdempotencyStore() }),
      { store, config: CONFIG },
    );
    const req = new Request("https://bff.test/api/calls", {
      method: "POST",
      headers: {
        Cookie: `anthos_session=${token}`,
        "Idempotency-Key": "11111111-1111-4111-8111-111111111111",
        "Content-Type": "application/json",
        "X-Trace-Id": "trace-compose",
      },
      body: JSON.stringify({ x: 1 }),
    });

    const res = await composed(req);
    expect(res.status).toBe(200);
    expect(received?.specialistId).toBe("S-COMPOSED");
    expect(received?.idempotencyKey).toBe("11111111-1111-4111-8111-111111111111");
    expect(received?.traceId).toBe("trace-compose");
    expect(res.headers.get("X-Trace-Id")).toBe("trace-compose");
  });
});

// ── rejection logging (P1A-06) ─────────────────────────────────────────────

describe("withSession — rejection logging", () => {
  it("emits a structured rejection event carrying trace_id and module", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { store, rows } = makeFakeStore();
    const token = seed(rows, { revoked: true });
    await withSession(okHandler(), { store, config: CONFIG })(
      makeReq({ token, traceId: "trace-rev" }),
    );
    const record = JSON.parse(String(warn.mock.calls.at(-1)?.[0]));
    expect(record.event).toBe("session_revoked");
    expect(record.trace_id).toBe("trace-rev");
    expect(record.module).toBe("api.session");
    expect(record.level).toBe("warn");
    warn.mockRestore();
  });

  it("never binds a specialist identifier onto a rejection log", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { store, rows } = makeFakeStore();
    const token = seed(rows, { revoked: true, specialistId: "S-SECRET" });
    await withSession(okHandler(), { store, config: CONFIG })(makeReq({ token }));
    const record = JSON.parse(String(warn.mock.calls.at(-1)?.[0]));
    expect(record).not.toHaveProperty("specialist_id");
    expect(String(warn.mock.calls)).not.toContain("S-SECRET");
    warn.mockRestore();
  });
});
