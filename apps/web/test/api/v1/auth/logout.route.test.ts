import { handleAuthCallback, handleAuthLogin, handleAuthLogout } from "@anthos/api";
import type {
  AuthLogoutOptions,
  CreateSessionInput,
  IdempotencyStore,
  SessionRecord,
  SessionStore,
} from "@anthos/api";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { POST } from "../../../../app/api/v1/auth/logout/route";

// Integration test for endpoint E-04. Two layers:
//  1. The Next.js route shim is driven end-to-end for the no-op path that
//     returns BEFORE touching the DB (absent session cookie) — proving the
//     shim → `@anthos/api` wiring.
//  2. The happy path runs the REAL login → callback → logout chain: a session
//     is minted by `handleAuthCallback` (which encrypts + stores the Salesforce
//     refresh token), then `handleAuthLogout` revokes it. Only `@anthos/api` is
//     imported — the session lifecycle is exercised through the public handlers.

const MOCK_SF_LOGIN_URL = "https://mock.my.salesforce.com";
const MOCK_INSTANCE_URL = "https://mock-instance.my.salesforce.com";
const LOGOUT_URL = "https://bff.test/api/v1/auth/logout";
const CALLBACK_URL = "https://bff.test/api/v1/auth/callback";
const SF_USER_ID = "0058K00000XYZAbQAO";
// The BFF's own origin — P1B-06's CSRF Origin check accepts it.
const ALLOWED_ORIGIN = "https://bff.test";

let savedEnv: NodeJS.ProcessEnv;

beforeAll(() => {
  savedEnv = { ...process.env };
  process.env.SF_LOGIN_URL = MOCK_SF_LOGIN_URL;
  process.env.SF_CONNECTED_APP_CONSUMER_KEY = "mock-client-id";
  process.env.SF_CONNECTED_APP_CONSUMER_SECRET = "mock-client-secret";
  process.env.SF_OAUTH_REDIRECT_URI = CALLBACK_URL;
  // Random keys per run — never a hardcoded secret in source.
  process.env.ANTHOS_OAUTH_COOKIE_SECRET = Buffer.from(
    crypto.getRandomValues(new Uint8Array(32)),
  ).toString("base64");
  process.env.ANTHOS_SF_TOKEN_ENC_KEY = Buffer.from(
    crypto.getRandomValues(new Uint8Array(32)),
  ).toString("base64");
  process.env.ANTHOS_ROLE_PERMISSION_SETS = JSON.stringify({
    Anthos_Aftercare_Specialist: "SPECIALIST",
  });
  // P1B-06 CSRF Origin allowlist — the BFF's own origin.
  process.env.ANTHOS_ALLOWED_ORIGINS = ALLOWED_ORIGIN;
});

afterAll(() => {
  process.env = savedEnv;
});

// Mint the two encrypted OAuth pre-session cookies the way P1B-01 would.
async function mintLoginCookies(): Promise<{ cookieHeader: string; state: string }> {
  const res = await handleAuthLogin(new Request("https://bff.test/api/v1/auth/login"));
  const state = new URL(res.headers.get("Location") ?? "").searchParams.get("state");
  if (state === null) {
    throw new Error("login redirect carried no state");
  }
  const cookieHeader = res.headers
    .getSetCookie()
    .map((c) => c.slice(0, c.indexOf(";")))
    .join("; ");
  return { cookieHeader, state };
}

// A `fetch` stand-in for the callback round-trip: the `authorization_code`
// token exchange + the `PermissionSetAssignment` SOQL.
function mockCallbackSalesforce(): typeof fetch {
  const fn = vi.fn(async (input: string | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/services/oauth2/token")) {
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            access_token: "00DU8!ACCESS",
            refresh_token: "5Aep861-INITIAL-REFRESH",
            instance_url: MOCK_INSTANCE_URL,
            id: `https://login.salesforce.com/id/00D8K000000ABCDUA0/${SF_USER_ID}`,
            scope: "api refresh_token",
          }),
      };
    }
    if (url.includes("/services/data/") && url.includes("query?q=")) {
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            totalSize: 1,
            done: true,
            records: [{ PermissionSet: { Name: "Anthos_Aftercare_Specialist" } }],
          }),
      };
    }
    throw new Error(`unexpected fetch to ${url}`);
  });
  return fn as unknown as typeof fetch;
}

// A real in-memory SessionStore: `handleAuthCallback` writes the session,
// `handleAuthLogout` reads and revokes it. `revoke` mirrors the real Postgres
// repo — it flips `revoked` AND nulls the stored Salesforce refresh token.
interface StoreRow {
  record: SessionRecord;
  revocationReason: string | null;
  sfRefreshTokenEncrypted: string | null;
}

function makeStore(): { store: SessionStore; sessions: () => StoreRow[] } {
  const rows = new Map<string, StoreRow>();
  let n = 0;
  const store: SessionStore = {
    create(input: CreateSessionInput) {
      n += 1;
      const record: SessionRecord = {
        id: `session-${n}`,
        specialistId: input.specialistId,
        role: input.role,
        lastActivityAt: new Date(),
        expiresAt: input.expiresAt,
        revoked: false,
        displayName: input.displayName ?? null,
        email: input.email ?? null,
        timezone: input.timezone ?? null,
      };
      rows.set(input.tokenHash, {
        record,
        revocationReason: null,
        sfRefreshTokenEncrypted: input.sfRefreshTokenEncrypted ?? null,
      });
      return Promise.resolve(record);
    },
    getByTokenHash(tokenHash) {
      return Promise.resolve(rows.get(tokenHash)?.record ?? null);
    },
    getSalesforceRefreshToken(tokenHash) {
      return Promise.resolve(rows.get(tokenHash)?.sfRefreshTokenEncrypted ?? null);
    },
    touch() {
      return Promise.resolve();
    },
    applySessionRefresh() {
      return Promise.resolve();
    },
    revoke(tokenHash, reason) {
      const row = rows.get(tokenHash);
      if (row) {
        row.record = { ...row.record, revoked: true };
        row.revocationReason = reason;
        row.sfRefreshTokenEncrypted = null;
      }
      return Promise.resolve();
    },
    cleanupExpired() {
      return Promise.resolve(0);
    },
  };
  return { store, sessions: () => [...rows.values()] };
}

// In-memory IdempotencyStore (acquire = INSERT … ON CONFLICT DO NOTHING).
function makeIdempotencyStore(): IdempotencyStore {
  const rows = new Map<string, Record<string, unknown>>();
  return {
    acquire(input) {
      if (rows.has(input.key)) {
        return Promise.resolve(null);
      }
      const row = {
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
      return Promise.resolve({ ...row } as never);
    },
    get: (key) => Promise.resolve((rows.get(key) as never) ?? null),
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
    delete: (key) => {
      rows.delete(key);
      return Promise.resolve();
    },
    cleanupExpired: () => Promise.resolve(0),
  };
}

// Fake DB handle for the audit-writer insert chain — captures inserted rows.
function makeDb(): {
  db: NonNullable<AuthLogoutOptions["db"]>;
  inserted: Record<string, unknown>[];
} {
  const inserted: Record<string, unknown>[] = [];
  const db = {
    insert() {
      return {
        values(value: Record<string, unknown>) {
          inserted.push(value);
          return {
            returning: () => Promise.resolve([{ id: `audit-${inserted.length}` }]),
          };
        },
      };
    },
  };
  return { db: db as unknown as NonNullable<AuthLogoutOptions["db"]>, inserted };
}

// Run the real login → callback chain, returning the `anthos_session` cookie
// token and the store that now holds the session + its encrypted refresh token.
async function establishSession(
  store: SessionStore,
  db: NonNullable<AuthLogoutOptions["db"]>,
): Promise<string> {
  const { cookieHeader, state } = await mintLoginCookies();
  const req = new Request(`${CALLBACK_URL}?code=sf-auth-code&state=${state}`, {
    headers: { cookie: cookieHeader, "user-agent": "Mozilla/5.0 (iPad)" },
  });
  const res = await handleAuthCallback(req, {
    store,
    db,
    fetchImpl: mockCallbackSalesforce(),
  });
  if (res.status !== 302) {
    throw new Error(`callback did not complete: ${res.status}`);
  }
  const sessionCookie = res.headers
    .getSetCookie()
    .find((c) => c.startsWith("anthos_session="));
  if (sessionCookie === undefined) {
    throw new Error("callback set no anthos_session cookie");
  }
  return sessionCookie.slice("anthos_session=".length, sessionCookie.indexOf(";"));
}

function logoutReq(token: string, key: string = crypto.randomUUID()): Request {
  return new Request(LOGOUT_URL, {
    method: "POST",
    headers: {
      Cookie: `anthos_session=${token}`,
      "Idempotency-Key": key,
      Origin: ALLOWED_ORIGIN,
    },
  });
}

function sessionEndCount(inserted: Record<string, unknown>[]): number {
  return inserted.filter((r) => r.actionType === "auth.session_end").length;
}

describe("POST /api/v1/auth/logout — route shim, DB-free no-op path (E-04)", () => {
  it("returns 204 when the session cookie is absent — no DB round-trip", async () => {
    const res = await POST(
      new Request(LOGOUT_URL, { method: "POST", headers: { Origin: ALLOWED_ORIGIN } }),
    );
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith("anthos_session="));
    expect(cookie).toContain("anthos_session=;");
    expect(cookie).toContain("Max-Age=0");
  });
});

describe("POST /api/v1/auth/logout — CSRF Origin validation (P1B-06)", () => {
  it("rejects a foreign Origin with 403 CSRF_ORIGIN_MISMATCH through the route shim", async () => {
    const { db, inserted } = makeDb();
    const res = await handleAuthLogout(
      new Request(LOGOUT_URL, {
        method: "POST",
        headers: { Origin: "https://evil.example", "Idempotency-Key": crypto.randomUUID() },
      }),
      { store: makeStore().store, db, idempotencyStore: makeIdempotencyStore() },
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "CSRF_ORIGIN_MISMATCH" });
    // The rejection is audited (auth.failure / csrf_origin_mismatch) before the 403.
    expect(
      inserted.some(
        (r) =>
          (r.payloadMetadata as Record<string, unknown>).reason ===
          "csrf_origin_mismatch",
      ),
    ).toBe(true);
  });
});

describe("POST /api/v1/auth/logout — full login → callback → logout chain (E-04)", () => {
  it("revokes the seeded session, wipes the SF refresh token, audits, clears the cookie", async () => {
    const { store, sessions } = makeStore();
    const { db, inserted } = makeDb();
    const token = await establishSession(store, db);

    const res = await handleAuthLogout(logoutReq(token), {
      store,
      db,
      idempotencyStore: makeIdempotencyStore(),
    });

    expect(res.status).toBe(204);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.text()).toBe("");

    // The session is revoked and its stored Salesforce refresh token is gone.
    const row = sessions()[0];
    expect(row?.record.revoked).toBe(true);
    expect(row?.revocationReason).toBe("logout");
    expect(row?.sfRefreshTokenEncrypted).toBeNull();

    // The cleared cookie expires the browser cookie immediately.
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith("anthos_session="));
    expect(cookie).toContain("anthos_session=;");
    expect(cookie).toContain("Max-Age=0");

    // Exactly one auth.session_end audit row (callback's session_start + this).
    expect(sessionEndCount(inserted)).toBe(1);
    const end = inserted.find((r) => r.actionType === "auth.session_end");
    expect(end?.outcome).toBe("SUCCESS");
    expect(end?.payloadMetadata).toMatchObject({ reason: "logout", role: "SPECIALIST" });
  });

  it("a second logout with a different key emits no duplicate auth.session_end", async () => {
    const { store } = makeStore();
    const { db, inserted } = makeDb();
    const token = await establishSession(store, db);
    const idempotencyStore = makeIdempotencyStore();

    const first = await handleAuthLogout(logoutReq(token), { store, db, idempotencyStore });
    const second = await handleAuthLogout(logoutReq(token), { store, db, idempotencyStore });

    expect(first.status).toBe(204);
    expect(second.status).toBe(204);
    // The session was already revoked by the first call — no duplicate audit.
    expect(sessionEndCount(inserted)).toBe(1);
  });

  it("a replay with the SAME key returns the cached 204 without re-running", async () => {
    const { store } = makeStore();
    const { db, inserted } = makeDb();
    const token = await establishSession(store, db);
    const idempotencyStore = makeIdempotencyStore();
    const key = crypto.randomUUID();

    const first = await handleAuthLogout(logoutReq(token, key), {
      store,
      db,
      idempotencyStore,
    });
    const replay = await handleAuthLogout(logoutReq(token, key), {
      store,
      db,
      idempotencyStore,
    });

    expect(first.status).toBe(204);
    expect(replay.status).toBe(204);
    expect(replay.headers.get("X-Idempotent-Replay")).toBe("true");
    // The core ran exactly once — one auth.session_end row.
    expect(sessionEndCount(inserted)).toBe(1);
  });
});
