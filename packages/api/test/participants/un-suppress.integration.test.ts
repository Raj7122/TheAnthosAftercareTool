// Integration tests for `DELETE /api/v1/participants/:id/suppression`
// (P1H-10 stub). The handler today returns a deterministic 404 — the tests
// pin the Pattern B + D scaffolding (session, idempotency, validation,
// replay) so the post-ratification ticket (P1H-10b) only swaps the handler
// body without rewiring middleware.

import { hashToken, loadSessionConfig, mintToken } from "@anthos/auth";
import type { Role } from "@anthos/auth";
import { describe, expect, it } from "vitest";

import { handleUnSuppress } from "../../src/participants/un-suppress.js";
import type {
  IdempotencyRecord,
  IdempotencyStatus,
  IdempotencyStore,
} from "../../src/idempotency/store.js";
import type { SessionRecord, SessionStore } from "../../src/session/store.js";

const SESSION_CONFIG = loadSessionConfig({});
const HOUR = 60 * 60 * 1000;
const SPECIALIST_ID = "0058K00000XYZAbQAO";
const PARTICIPANT_ID = "a015g00000ABCDxQAO";
const IDEM_KEY = "11111111-1111-4111-8111-111111111111";
const IDEM_KEY_B = "22222222-2222-4222-8222-222222222222";

function makeStore(): { store: SessionStore; seed: (role?: Role) => string } {
  const rows = new Map<string, SessionRecord>();
  let n = 0;
  const store: SessionStore = {
    create: () => Promise.reject(new Error("create unused")),
    getByTokenHash: (h) => Promise.resolve(rows.get(h) ?? null),
    getSalesforceRefreshToken: () => Promise.resolve(null),
    touch: () => Promise.resolve(),
    applySessionRefresh: () => Promise.resolve(),
    revoke: () => Promise.resolve(),
    cleanupExpired: () => Promise.resolve(0),
  };
  function seed(role: Role = "SPECIALIST"): string {
    n += 1;
    const token = mintToken();
    rows.set(hashToken(token), {
      id: `session-${n}`,
      specialistId: SPECIALIST_ID,
      role,
      lastActivityAt: new Date(),
      expiresAt: new Date(Date.now() + 11 * HOUR),
      revoked: false,
      displayName: "Marie Alcis",
      email: "malcis@anthoshome.org",
      timezone: "America/New_York",
    });
    return token;
  }
  return { store, seed };
}

interface FakeIdemRow {
  key: string;
  specialistId: string;
  status: IdempotencyStatus;
  requestHash: string | null;
  responseStatusCode: number | null;
  responseBody: unknown;
  traceId: string | null;
  expiresAt: Date;
}

function makeIdemStore(): IdempotencyStore {
  const rows = new Map<string, FakeIdemRow>();
  return {
    acquire(input) {
      if (rows.has(input.key)) return Promise.resolve(null);
      const row: FakeIdemRow = {
        key: input.key,
        specialistId: input.specialistId,
        status: "IN_FLIGHT",
        requestHash: input.requestHash,
        responseStatusCode: null,
        responseBody: null,
        traceId: input.traceId,
        expiresAt: new Date(Date.now() + 24 * HOUR),
      };
      rows.set(input.key, row);
      return Promise.resolve({ ...row } as IdempotencyRecord);
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
      return Promise.resolve(0);
    },
  };
}

function deleteReq(
  token: string | undefined,
  idempotencyKey: string | null = IDEM_KEY,
  participantId: string = PARTICIPANT_ID,
  traceId?: string,
): Request {
  const headers = new Headers();
  if (token !== undefined) headers.set("Cookie", `anthos_session=${token}`);
  if (idempotencyKey !== null) headers.set("Idempotency-Key", idempotencyKey);
  if (traceId !== undefined) headers.set("X-Trace-Id", traceId);
  return new Request(
    `https://bff.test/api/v1/participants/${participantId}/suppression`,
    { method: "DELETE", headers },
  );
}

function routeCtx(participantId: string = PARTICIPANT_ID) {
  return { params: Promise.resolve({ id: participantId }) };
}

// ── auth + idempotency gates ────────────────────────────────────────────────

describe("handleUnSuppress — auth + idempotency gates", () => {
  it("401 AUTH_SESSION_INVALID when no session cookie is present", async () => {
    const { store } = makeStore();
    const res = await handleUnSuppress(deleteReq(undefined), routeCtx(), {
      store,
      sessionConfig: SESSION_CONFIG,
      idempotencyStore: makeIdemStore(),
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe(
      "AUTH_SESSION_INVALID",
    );
  });

  it("400 IDEMPOTENCY_KEY_REQUIRED when header is missing", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const res = await handleUnSuppress(deleteReq(token, null), routeCtx(), {
      store,
      sessionConfig: SESSION_CONFIG,
      idempotencyStore: makeIdemStore(),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe(
      "IDEMPOTENCY_KEY_REQUIRED",
    );
  });
});

// ── request validation ──────────────────────────────────────────────────────

describe("handleUnSuppress — validation", () => {
  it("422 VALIDATION_FAILED on invalid participant id shape", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const res = await handleUnSuppress(
      deleteReq(token, IDEM_KEY, "not-an-sf-id"),
      routeCtx("not-an-sf-id"),
      {
        store,
        sessionConfig: SESSION_CONFIG,
        idempotencyStore: makeIdemStore(),
      },
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      code: string;
      details?: { field?: string };
    };
    expect(body.code).toBe("VALIDATION_FAILED");
    expect(body.details?.field).toBe("participantId");
  });
});

// ── stub deterministic 404 ──────────────────────────────────────────────────

describe("handleUnSuppress — Pattern F stub (deterministic 404)", () => {
  it("404 RESOURCE_NOT_FOUND with details.resource=suppression on a valid call", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const res = await handleUnSuppress(deleteReq(token), routeCtx(), {
      store,
      sessionConfig: SESSION_CONFIG,
      idempotencyStore: makeIdemStore(),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as {
      code: string;
      message: string;
      details?: { resource?: string };
    };
    expect(body.code).toBe("RESOURCE_NOT_FOUND");
    expect(body.details?.resource).toBe("suppression");
    // The deterministic stub message MUST NOT carry PII (no participant id,
    // no provider, no reason). Reason: PII firewall + future-proofing once
    // the handler's body grows in P1H-10b.
    expect(body.message).toBe("No active suppression to clear.");
  });

  it("returns no-store + X-Trace-Id headers on the stub 404", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const traceId = "trace-stub-1";
    const res = await handleUnSuppress(
      deleteReq(token, IDEM_KEY, PARTICIPANT_ID, traceId),
      routeCtx(),
      {
        store,
        sessionConfig: SESSION_CONFIG,
        idempotencyStore: makeIdemStore(),
      },
    );
    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Trace-Id")).toBe(traceId);
  });

  it("works for VP role just as it does for SPECIALIST (same stub 404)", async () => {
    // The role-gate logic lands with P1H-10b; today the handler does not
    // discriminate by role because the 404 fires before any data access.
    // This test pins the current behavior — when P1H-10b adds the gate,
    // this assertion needs to either move to a fixture that simulates an
    // active suppression OR be replaced with the role-matrix tests.
    const { store, seed } = makeStore();
    const token = seed("VP");
    const res = await handleUnSuppress(deleteReq(token), routeCtx(), {
      store,
      sessionConfig: SESSION_CONFIG,
      idempotencyStore: makeIdemStore(),
    });
    expect(res.status).toBe(404);
  });
});

// ── idempotency replay ──────────────────────────────────────────────────────

describe("handleUnSuppress — idempotency replay", () => {
  it("replays the stored 404 on the second call with the same key", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const idemStore = makeIdemStore();
    const res1 = await handleUnSuppress(deleteReq(token, IDEM_KEY), routeCtx(), {
      store,
      sessionConfig: SESSION_CONFIG,
      idempotencyStore: idemStore,
    });
    expect(res1.status).toBe(404);
    const body1 = (await res1.json()) as { code: string };

    const res2 = await handleUnSuppress(deleteReq(token, IDEM_KEY), routeCtx(), {
      store,
      sessionConfig: SESSION_CONFIG,
      idempotencyStore: idemStore,
    });
    expect(res2.status).toBe(404);
    const body2 = (await res2.json()) as { code: string };
    expect(body2).toEqual(body1);
  });

  it("a different key produces an independent 404 (no cross-key leakage)", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const idemStore = makeIdemStore();
    const res1 = await handleUnSuppress(deleteReq(token, IDEM_KEY), routeCtx(), {
      store,
      sessionConfig: SESSION_CONFIG,
      idempotencyStore: idemStore,
    });
    const res2 = await handleUnSuppress(
      deleteReq(token, IDEM_KEY_B),
      routeCtx(),
      {
        store,
        sessionConfig: SESSION_CONFIG,
        idempotencyStore: idemStore,
      },
    );
    expect(res1.status).toBe(404);
    expect(res2.status).toBe(404);
  });
});
