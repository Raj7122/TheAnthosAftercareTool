import { handleAuthCallback, handleAuthLogin, handleAuthRefresh } from "@anthos/api";
import type {
  AuthRefreshOptions,
  CreateSessionInput,
  IdempotencyStore,
  RateLimiter,
  SessionRecord,
  SessionStore,
} from "@anthos/api";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { POST } from "../../../../app/api/v1/auth/refresh/route";

// Integration test for endpoint E-03. Two layers:
//  1. The Next.js route shim is driven end-to-end for the failure path that
//     returns BEFORE touching the DB (absent session cookie) — proving the
//     shim → `@anthos/api` wiring.
//  2. The happy path runs the REAL login → callback → refresh chain: a session
//     is minted by `handleAuthCallback` (which encrypts + stores the Salesforce
//     refresh token), then `handleAuthRefresh` exchanges that stored token
//     against a mock Salesforce `/services/oauth2/token` endpoint. Only
//     `@anthos/api` is imported — the session-crypto round-trip is exercised
//     entirely through the public handlers.

const MOCK_SF_LOGIN_URL = "https://mock.my.salesforce.com";
const MOCK_INSTANCE_URL = "https://mock-instance.my.salesforce.com";
const REFRESH_URL = "https://bff.test/api/v1/auth/refresh";
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

// A `fetch` stand-in for the refresh-token grant.
function mockRefreshSalesforce(opts: { status?: number; body?: string } = {}): typeof fetch {
  const fn = vi.fn(async (input: string | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/services/oauth2/token")) {
      return {
        ok: (opts.status ?? 200) < 400,
        status: opts.status ?? 200,
        text: async () =>
          opts.body ??
          JSON.stringify({
            access_token: "00DU8!ACCESS-REFRESHED",
            refresh_token: "5Aep861-ROTATED-REFRESH",
            instance_url: MOCK_INSTANCE_URL,
            scope: "api refresh_token",
            expires_in: 7200,
          }),
      };
    }
    throw new Error(`unexpected fetch to ${url}`);
  });
  return fn as unknown as typeof fetch;
}

// A real in-memory SessionStore keyed by token hash — `handleAuthCallback`
// writes the session, `handleAuthRefresh` reads and refreshes it.
function makeStore(): {
  store: SessionStore;
  rotatedCiphertext: () => string | undefined;
} {
  interface Row {
    record: SessionRecord;
    sfRefreshTokenEncrypted: string | null;
  }
  const rows = new Map<string, Row>();
  let rotated: string | undefined;
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
    applySessionRefresh(tokenHash, now, rotatedRefreshTokenEncrypted) {
      const row = rows.get(tokenHash);
      if (row) {
        row.record = { ...row.record, lastActivityAt: now };
        if (rotatedRefreshTokenEncrypted !== undefined) {
          row.sfRefreshTokenEncrypted = rotatedRefreshTokenEncrypted;
          rotated = rotatedRefreshTokenEncrypted;
        }
      }
      return Promise.resolve();
    },
    revoke() {
      return Promise.resolve();
    },
    cleanupExpired() {
      return Promise.resolve(0);
    },
  };
  return { store, rotatedCiphertext: () => rotated };
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

const allowingRateLimiter: RateLimiter = {
  checkAndConsume: () => Promise.resolve({ allowed: true }),
};

// Fake DB handle for the audit-writer insert chain.
function makeDb(): {
  db: NonNullable<AuthRefreshOptions["db"]>;
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
  return { db: db as unknown as NonNullable<AuthRefreshOptions["db"]>, inserted };
}

// Run the real login → callback chain, returning the `anthos_session` cookie
// token and the store that now holds the session + its encrypted refresh token.
async function establishSession(
  store: SessionStore,
  db: NonNullable<AuthRefreshOptions["db"]>,
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

function refreshReq(token: string): Request {
  return new Request(REFRESH_URL, {
    method: "POST",
    headers: {
      Cookie: `anthos_session=${token}`,
      "Idempotency-Key": crypto.randomUUID(),
      Origin: ALLOWED_ORIGIN,
    },
  });
}

describe("POST /api/v1/auth/refresh — route shim, DB-free failure path (E-03)", () => {
  it("returns 401 AUTH_SESSION_INVALID when the session cookie is absent", async () => {
    const res = await POST(
      new Request(REFRESH_URL, { method: "POST", headers: { Origin: ALLOWED_ORIGIN } }),
    );
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe("AUTH_SESSION_INVALID");
  });
});

describe("POST /api/v1/auth/refresh — CSRF Origin validation (P1B-06)", () => {
  it("rejects a foreign Origin with 403 CSRF_ORIGIN_MISMATCH before the SF exchange", async () => {
    const { store } = makeStore();
    const { db, inserted } = makeDb();
    const fetchImpl = mockRefreshSalesforce();

    const res = await handleAuthRefresh(
      new Request(REFRESH_URL, {
        method: "POST",
        headers: {
          Cookie: "anthos_session=irrelevant",
          "Idempotency-Key": crypto.randomUUID(),
          Origin: "https://evil.example",
        },
      }),
      { store, db, rateLimiter: allowingRateLimiter, idempotencyStore: makeIdempotencyStore(), fetchImpl },
    );

    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("CSRF_ORIGIN_MISMATCH");
    // No Salesforce token exchange — the CSRF gate runs first.
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
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

describe("POST /api/v1/auth/refresh — full login → callback → refresh chain (E-03)", () => {
  it("exchanges the stored refresh token against mock Salesforce, rotates it, audits", async () => {
    const { store, rotatedCiphertext } = makeStore();
    const { db, inserted } = makeDb();
    const token = await establishSession(store, db);
    const fetchImpl = mockRefreshSalesforce();

    const res = await handleAuthRefresh(refreshReq(token), {
      store,
      db,
      rateLimiter: allowingRateLimiter,
      idempotencyStore: makeIdempotencyStore(),
      fetchImpl,
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = (await res.json()) as {
      sessionExpiresAt: string;
      idleTimeoutSeconds: number;
    };
    expect(typeof body.sessionExpiresAt).toBe("string");
    expect(body.idleTimeoutSeconds).toBe(1800);

    // The mock Salesforce token endpoint was hit with the refresh_token grant.
    const fetchMock = fetchImpl as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock.mock.calls).toHaveLength(1);
    const exchangeBody = String(
      (fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body ?? "",
    );
    expect(exchangeBody).toContain("grant_type=refresh_token");

    // The rotated refresh token was persisted, encrypted — and never surfaced.
    const rotated = rotatedCiphertext();
    expect(rotated).toBeDefined();
    expect(rotated).not.toContain("5Aep861");
    const cookie = res.headers
      .getSetCookie()
      .find((c) => c.startsWith("anthos_session="));
    expect(cookie).toBeDefined();
    const serialized = [JSON.stringify(body), ...res.headers.getSetCookie()].join("\n");
    expect(serialized).not.toContain("5Aep861-ROTATED-REFRESH");
    expect(serialized).not.toContain("00DU8!ACCESS-REFRESHED");

    // The auth.session_refresh row was written (callback's row + this one).
    const refreshRow = inserted.find((r) => r.actionType === "auth.session_refresh");
    expect(refreshRow).toBeDefined();
  });

  it("returns 401 AUTH_SESSION_INVALID when Salesforce rejects the refresh token", async () => {
    const { store } = makeStore();
    const { db, inserted } = makeDb();
    const token = await establishSession(store, db);

    const res = await handleAuthRefresh(refreshReq(token), {
      store,
      db,
      rateLimiter: allowingRateLimiter,
      idempotencyStore: makeIdempotencyStore(),
      fetchImpl: mockRefreshSalesforce({
        status: 400,
        body: JSON.stringify({ error: "invalid_grant" }),
      }),
    });

    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe("AUTH_SESSION_INVALID");
    const failureRow = inserted.find((r) => r.actionType === "auth.failure");
    expect(failureRow?.payloadMetadata).toEqual({ reason: "refresh_token_invalid" });
  });
});
