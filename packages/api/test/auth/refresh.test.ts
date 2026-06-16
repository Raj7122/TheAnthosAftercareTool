import { randomBytes, randomUUID } from "node:crypto";

import { aeadDecrypt, aeadEncrypt, hashToken, loadSessionConfig, mintToken } from "@anthos/auth";
import type { CookieAttributes, Role } from "@anthos/auth";
import { SalesforceError } from "@anthos/integrations";
import type { RefreshTokenExchangeResult } from "@anthos/integrations";
import type { DbOrTx } from "@anthos/persistence";
import { describe, expect, it, vi } from "vitest";

import { handleAuthRefresh } from "../../src/auth/refresh.js";
import type { AuthRefreshOptions, RefreshTokenExchanger } from "../../src/auth/refresh.js";
import type { AuthRefreshConfig } from "../../src/auth/refresh-config.js";
import type { IdempotencyRecord, IdempotencyStatus, IdempotencyStore } from "../../src/idempotency/store.js";
import type { RateLimiter } from "../../src/ratelimit/store.js";
import type { SessionRecord, SessionStore } from "../../src/session/store.js";

// ── fixtures ────────────────────────────────────────────────────────────────

const SF_TOKEN_ENC_KEY = randomBytes(32);
const STORED_REFRESH_TOKEN = "5Aep861-STORED-REFRESH-TOKEN-placeholder";
const ROTATED_REFRESH_TOKEN = "5Aep861-ROTATED-REFRESH-TOKEN-placeholder";
const SF_ACCESS_TOKEN = "00DU8!ACCESS-TOKEN-placeholder";

const SESSION_COOKIE_IFRAME: CookieAttributes = {
  httpOnly: true,
  secure: true,
  sameSite: "None",
  path: "/",
};

function makeConfig(overrides: Partial<AuthRefreshConfig> = {}): AuthRefreshConfig {
  return {
    loginUrl: "https://example.my.salesforce.com",
    clientId: "client-abc",
    clientSecret: "client-secret-placeholder",
    sfTokenEncKey: SF_TOKEN_ENC_KEY,
    session: loadSessionConfig({}),
    sessionCookie: SESSION_COOKIE_IFRAME,
    ...overrides,
  };
}

function exchangeResult(
  overrides: Partial<RefreshTokenExchangeResult> = {},
): RefreshTokenExchangeResult {
  return {
    accessToken: SF_ACCESS_TOKEN,
    instanceUrl: "https://example.my.salesforce.com",
    scope: "api refresh_token",
    ...overrides,
  };
}

interface FakeSession {
  id: string;
  specialistId: string;
  role: Role;
  lastActivityAt: Date;
  expiresAt: Date;
  revoked: boolean;
  sfRefreshTokenEncrypted: string | null;
}

interface RefreshCall {
  tokenHash: string;
  rotatedRefreshTokenEncrypted: string | undefined;
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

// In-memory SessionStore holding real rows so `refreshSession` resolves them.
function makeSessionStore(): {
  store: SessionStore;
  rows: Map<string, FakeSession>;
  refreshCalls: RefreshCall[];
} {
  const rows = new Map<string, FakeSession>();
  const refreshCalls: RefreshCall[] = [];
  const store: SessionStore = {
    create() {
      return Promise.reject(new Error("create not used in refresh tests"));
    },
    getByTokenHash(tokenHash) {
      const row = rows.get(tokenHash);
      return Promise.resolve(row ? toRecord(row) : null);
    },
    getSalesforceRefreshToken(tokenHash) {
      return Promise.resolve(rows.get(tokenHash)?.sfRefreshTokenEncrypted ?? null);
    },
    touch() {
      return Promise.resolve();
    },
    applySessionRefresh(tokenHash, now, rotatedRefreshTokenEncrypted) {
      refreshCalls.push({ tokenHash, rotatedRefreshTokenEncrypted });
      const row = rows.get(tokenHash);
      if (row) {
        row.lastActivityAt = now;
        if (rotatedRefreshTokenEncrypted !== undefined) {
          row.sfRefreshTokenEncrypted = rotatedRefreshTokenEncrypted;
        }
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
  return { store, rows, refreshCalls };
}

// In-memory IdempotencyStore — mirrors packages/api/test/idempotency/middleware.test.ts.
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

function makeIdempotencyStore(): IdempotencyStore {
  const rows = new Map<string, FakeIdemRow>();
  return {
    acquire(input) {
      if (rows.has(input.key)) {
        return Promise.resolve(null);
      }
      const row: FakeIdemRow = {
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
      return Promise.resolve(0);
    },
  };
}

// Fake RateLimiter — `allowed` fixed; counts calls.
function makeRateLimiter(allowed: boolean): RateLimiter & { calls: () => number } {
  let calls = 0;
  return {
    checkAndConsume() {
      calls += 1;
      return Promise.resolve(
        allowed ? { allowed: true } : { allowed: false, retryAfterSeconds: 5 },
      );
    },
    calls: () => calls,
  };
}

// Minimal stand-in for the Drizzle insert chain `writeAuditEntry` drives. The
// real `writeAuditEntry` (incl. its no-PII assertion) runs against it.
function makeFakeDb(): { db: DbOrTx; inserted: Record<string, unknown>[] } {
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
  return { db: db as unknown as DbOrTx, inserted };
}

interface SeedOpts {
  lastActivityAt?: Date;
  expiresAt?: Date;
  revoked?: boolean;
  sfRefreshTokenEncrypted?: string | null;
}

// Seed a session row and return its plaintext cookie token. The stored refresh
// token is real AES-256-GCM ciphertext so the handler's decrypt runs for real.
function seed(
  rows: Map<string, FakeSession>,
  opts: SeedOpts = {},
): { token: string; tokenHash: string; sessionId: string } {
  const token = mintToken();
  const tokenHash = hashToken(token);
  const sessionId = `session-${rows.size + 1}`;
  rows.set(tokenHash, {
    id: sessionId,
    specialistId: "0058K00000XYZAbQAO",
    role: "SPECIALIST",
    lastActivityAt: opts.lastActivityAt ?? new Date(),
    expiresAt: opts.expiresAt ?? new Date(Date.now() + 11 * 60 * 60 * 1000),
    revoked: opts.revoked ?? false,
    sfRefreshTokenEncrypted:
      opts.sfRefreshTokenEncrypted === undefined
        ? aeadEncrypt(STORED_REFRESH_TOKEN, SF_TOKEN_ENC_KEY)
        : opts.sfRefreshTokenEncrypted,
  });
  return { token, tokenHash, sessionId };
}

// The BFF's own origin — same host as the request URL below. P1B-06's Origin
// check accepts it; tests pass `origin: "https://evil.example"` or
// `origin: null` to exercise the CSRF rejection path.
const ALLOWED_ORIGIN = "https://bff.test";

function refreshReq(
  opts: {
    token?: string | null;
    key?: string | null;
    traceId?: string;
    origin?: string | null;
  } = {},
): Request {
  const headers = new Headers();
  if (opts.token !== null) {
    headers.set("Cookie", `anthos_session=${opts.token ?? "missing"}`);
  }
  if (opts.key !== null) {
    headers.set("Idempotency-Key", opts.key ?? randomUUID());
  }
  if (opts.traceId !== undefined) {
    headers.set("X-Trace-Id", opts.traceId);
  }
  // Browsers always send `Origin` on a POST; default to the allowed BFF
  // origin. `origin: null` simulates an absent header.
  if (opts.origin !== null) {
    headers.set("Origin", opts.origin ?? ALLOWED_ORIGIN);
  }
  return new Request("https://bff.test/api/v1/auth/refresh", {
    method: "POST",
    headers,
  });
}

// A happy-path options bundle. Individual tests override pieces.
function happyOptions(overrides: Partial<AuthRefreshOptions> = {}): {
  options: AuthRefreshOptions;
  rows: Map<string, FakeSession>;
  refreshCalls: RefreshCall[];
  inserted: Record<string, unknown>[];
  exchangeCalls: () => number;
} {
  const { store, rows, refreshCalls } = makeSessionStore();
  const { db, inserted } = makeFakeDb();
  let exchangeCalls = 0;
  const exchangeRefreshToken: RefreshTokenExchanger = () => {
    exchangeCalls += 1;
    return Promise.resolve(exchangeResult());
  };
  return {
    options: {
      config: makeConfig(),
      store,
      db,
      rateLimiter: makeRateLimiter(true),
      idempotencyStore: makeIdempotencyStore(),
      exchangeRefreshToken,
      originConfig: { allowedOrigins: [ALLOWED_ORIGIN] },
      ...overrides,
    },
    rows,
    refreshCalls,
    inserted,
    exchangeCalls: () => exchangeCalls,
  };
}

// ── happy path ──────────────────────────────────────────────────────────────

describe("handleAuthRefresh — success (E-03)", () => {
  it("returns 200 with sessionExpiresAt + idleTimeoutSeconds and a refreshed cookie", async () => {
    const { options, rows } = happyOptions();
    const { token, tokenHash } = seed(rows);
    const expiresAt = rows.get(tokenHash)?.expiresAt;

    const res = await handleAuthRefresh(refreshReq({ token }), options);

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Trace-Id")).toBeTruthy();
    expect(await res.json()).toEqual({
      sessionExpiresAt: expiresAt?.toISOString(),
      idleTimeoutSeconds: 1800,
    });

    const cookie = res.headers.getSetCookie().find((c) => c.startsWith("anthos_session="));
    expect(cookie).toBeDefined();
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=None");
    expect(cookie).toContain("Max-Age=1800");
    // The opaque session token is unchanged — only the cookie Max-Age refreshes.
    expect(cookie).toContain(`anthos_session=${token}`);
  });

  it("writes one auth.session_refresh audit row — session id + role, trace id, no PII", async () => {
    const { options, inserted, rows } = happyOptions();
    const { token, sessionId } = seed(rows);

    const res = await handleAuthRefresh(
      refreshReq({ token, traceId: "trace-refresh-ok" }),
      options,
    );

    expect(res.status).toBe(200);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.actionType).toBe("auth.session_refresh");
    expect(inserted[0]?.outcome).toBe("SUCCESS");
    expect(inserted[0]?.traceId).toBe("trace-refresh-ok");
    expect(inserted[0]?.payloadMetadata).toEqual({
      session_id: sessionId,
      role: "SPECIALIST",
    });
  });

  it("accepts a soft-expired (idle-expired) session within the absolute window", async () => {
    const { options, rows } = happyOptions();
    const { token } = seed(rows, {
      // idle-expired (last activity 1h ago) but well inside the 12h cap.
      lastActivityAt: new Date(Date.now() - 60 * 60 * 1000),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    const res = await handleAuthRefresh(refreshReq({ token }), options);
    expect(res.status).toBe(200);
  });
});

// ── refresh-token rotation (SEC-AUTH-6) ─────────────────────────────────────

describe("handleAuthRefresh — refresh-token rotation", () => {
  it("persists a Salesforce-rotated refresh token, overwriting the stored ciphertext", async () => {
    const exchangeRefreshToken: RefreshTokenExchanger = () =>
      Promise.resolve(exchangeResult({ refreshToken: ROTATED_REFRESH_TOKEN }));
    const { options, rows, refreshCalls } = happyOptions({ exchangeRefreshToken });
    const { token, tokenHash } = seed(rows);

    const res = await handleAuthRefresh(refreshReq({ token }), options);

    expect(res.status).toBe(200);
    const rotated = refreshCalls[0]?.rotatedRefreshTokenEncrypted;
    expect(rotated).toBeDefined();
    // The stored ciphertext now decrypts to the NEW refresh token.
    expect(aeadDecrypt(rotated as string, SF_TOKEN_ENC_KEY)).toBe(ROTATED_REFRESH_TOKEN);
    expect(
      aeadDecrypt(rows.get(tokenHash)?.sfRefreshTokenEncrypted as string, SF_TOKEN_ENC_KEY),
    ).toBe(ROTATED_REFRESH_TOKEN);
  });

  it("retains the stored refresh token when Salesforce did not rotate", async () => {
    const { options, rows, refreshCalls } = happyOptions();
    const { token, tokenHash } = seed(rows);
    const before = rows.get(tokenHash)?.sfRefreshTokenEncrypted;

    const res = await handleAuthRefresh(refreshReq({ token }), options);

    expect(res.status).toBe(200);
    expect(refreshCalls[0]?.rotatedRefreshTokenEncrypted).toBeUndefined();
    expect(rows.get(tokenHash)?.sfRefreshTokenEncrypted).toBe(before);
  });
});

// ── session rejection (401 AUTH_SESSION_INVALID) ────────────────────────────

describe("handleAuthRefresh — non-refreshable sessions return 401", () => {
  it("401 when the anthos_session cookie is absent", async () => {
    const { options, inserted } = happyOptions();
    const res = await handleAuthRefresh(refreshReq({ token: null }), options);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: "AUTH_SESSION_INVALID" });
    expect(inserted).toHaveLength(0);
  });

  it("401 when no session matches the cookie token", async () => {
    const { options } = happyOptions();
    const res = await handleAuthRefresh(refreshReq({ token: mintToken() }), options);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: "AUTH_SESSION_INVALID" });
  });

  it("401 for a revoked session", async () => {
    const { options, rows } = happyOptions();
    const { token } = seed(rows, { revoked: true });
    const res = await handleAuthRefresh(refreshReq({ token }), options);
    expect(res.status).toBe(401);
  });

  it("401 for a session past the 12h absolute cap", async () => {
    const { options, rows } = happyOptions();
    const { token } = seed(rows, { expiresAt: new Date(Date.now() - 1000) });
    const res = await handleAuthRefresh(refreshReq({ token }), options);
    expect(res.status).toBe(401);
  });

  it("401 + auth.failure when the session has no stored refresh token", async () => {
    const { options, inserted, rows } = happyOptions();
    const { token } = seed(rows, { sfRefreshTokenEncrypted: null });

    const res = await handleAuthRefresh(refreshReq({ token }), options);

    expect(res.status).toBe(401);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.actionType).toBe("auth.failure");
    expect(inserted[0]?.payloadMetadata).toEqual({ reason: "refresh_token_absent" });
  });
});

// ── Salesforce exchange failures ────────────────────────────────────────────

describe("handleAuthRefresh — Salesforce exchange failures", () => {
  it("401 AUTH_SESSION_INVALID + auth.failure on invalid_grant (dead refresh token)", async () => {
    const exchangeRefreshToken: RefreshTokenExchanger = () =>
      Promise.reject(new SalesforceError("SF_AUTH_FAILED", "invalid_grant"));
    const { options, inserted, rows } = happyOptions({ exchangeRefreshToken });
    const { token } = seed(rows);

    const res = await handleAuthRefresh(refreshReq({ token }), options);

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: "AUTH_SESSION_INVALID" });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.actionType).toBe("auth.failure");
    expect(inserted[0]?.payloadMetadata).toEqual({ reason: "refresh_token_invalid" });
  });

  it("503 SF_UPSTREAM_UNAVAILABLE + auth.failure on a Salesforce network timeout", async () => {
    const exchangeRefreshToken: RefreshTokenExchanger = () =>
      Promise.reject(new SalesforceError("SF_NETWORK_TIMEOUT", "timed out"));
    const { options, inserted, rows } = happyOptions({ exchangeRefreshToken });
    const { token } = seed(rows);

    const res = await handleAuthRefresh(refreshReq({ token }), options);

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "SF_UPSTREAM_UNAVAILABLE" });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.payloadMetadata).toEqual({ reason: "sf_unavailable" });
  });

  it("401 + auth.failure when the stored refresh token cannot be decrypted", async () => {
    const { options, inserted, rows } = happyOptions();
    // A ciphertext encrypted under a DIFFERENT key — AEAD decrypt will fail.
    const { token } = seed(rows, {
      sfRefreshTokenEncrypted: aeadEncrypt("x", randomBytes(32)),
    });

    const res = await handleAuthRefresh(refreshReq({ token }), options);

    expect(res.status).toBe(401);
    expect(inserted[0]?.payloadMetadata).toEqual({
      reason: "refresh_token_decrypt_failed",
    });
  });
});

// ── rate limiting (API §6: 1 per 5s per specialist) ─────────────────────────

describe("handleAuthRefresh — rate limiting", () => {
  it("429 RATE_LIMITED + Retry-After + auth.failure when the limiter throttles", async () => {
    const { options, inserted, rows } = happyOptions({
      rateLimiter: makeRateLimiter(false),
    });
    const { token } = seed(rows);

    const res = await handleAuthRefresh(refreshReq({ token }), options);

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("5");
    const body = (await res.json()) as { code: string; details: { limit: number } };
    expect(body.code).toBe("RATE_LIMITED");
    expect(body.details.limit).toBe(1);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.actionType).toBe("auth.failure");
    expect(inserted[0]?.payloadMetadata).toEqual({ reason: "rate_limited" });
  });
});

// ── idempotency (Pattern D / Immutable #6) ──────────────────────────────────

describe("handleAuthRefresh — idempotency", () => {
  it("400 IDEMPOTENCY_KEY_REQUIRED when the header is absent", async () => {
    const { options, rows } = happyOptions();
    const { token } = seed(rows);
    const res = await handleAuthRefresh(refreshReq({ token, key: null }), options);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "IDEMPOTENCY_KEY_REQUIRED" });
  });

  it("replays the cached 200 without re-rotating or re-auditing", async () => {
    const { options, rows, inserted, refreshCalls, exchangeCalls } = happyOptions();
    const { token } = seed(rows);
    const key = randomUUID();

    const first = await handleAuthRefresh(refreshReq({ token, key }), options);
    const replay = await handleAuthRefresh(refreshReq({ token, key }), options);

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(replay.headers.get("X-Idempotent-Replay")).toBe("true");
    // The core ran exactly once: one SF exchange, one rotation, one audit row.
    expect(exchangeCalls()).toBe(1);
    expect(refreshCalls).toHaveLength(1);
    expect(inserted).toHaveLength(1);
  });
});

// ── secrecy (TR-AUTH-3 / SEC-AUTH-2 / no-PII) ───────────────────────────────

describe("handleAuthRefresh — secrecy", () => {
  it("never leaks refresh or access tokens to the response, headers, or logs", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const exchangeRefreshToken: RefreshTokenExchanger = () =>
        Promise.resolve(exchangeResult({ refreshToken: ROTATED_REFRESH_TOKEN }));
      const { options, rows } = happyOptions({ exchangeRefreshToken });
      const { token } = seed(rows);

      const res = await handleAuthRefresh(refreshReq({ token }), options);
      const serialized = [
        await res.clone().text(),
        ...res.headers.getSetCookie(),
        res.headers.get("X-Trace-Id") ?? "",
      ].join("\n");
      const logged = [...log.mock.calls, ...warn.mock.calls, ...error.mock.calls]
        .map((call) => String(call[0]))
        .join("\n");

      expect(res.status).toBe(200);
      for (const secret of [
        STORED_REFRESH_TOKEN,
        ROTATED_REFRESH_TOKEN,
        SF_ACCESS_TOKEN,
      ]) {
        expect(serialized).not.toContain(secret);
        expect(logged).not.toContain(secret);
      }
    } finally {
      log.mockRestore();
      warn.mockRestore();
      error.mockRestore();
    }
  });
});

// ── CSRF Origin validation (P1B-06 / API §8.6 / SEC-THREAT-1) ───────────────

describe("handleAuthRefresh — Origin validation", () => {
  it("rejects a mismatched Origin with 403 CSRF_ORIGIN_MISMATCH before the SF exchange", async () => {
    const { options, rows, exchangeCalls, refreshCalls } = happyOptions();
    const { token } = seed(rows);

    const res = await handleAuthRefresh(
      refreshReq({ token, origin: "https://evil.example" }),
      options,
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "CSRF_ORIGIN_MISMATCH" });
    // The CSRF gate runs ahead of the rate limit, the cookie parse, and the
    // Salesforce token exchange — none of them ran.
    expect(exchangeCalls()).toBe(0);
    expect(refreshCalls).toHaveLength(0);
  });

  it("rejects an absent Origin on the POST", async () => {
    const { options } = happyOptions();
    const res = await handleAuthRefresh(refreshReq({ token: null, origin: null }), options);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "CSRF_ORIGIN_MISMATCH" });
  });

  it("writes one auth.failure / csrf_origin_mismatch audit row BEFORE the 403 — sentinel actor, no PII", async () => {
    const { options, rows, inserted } = happyOptions();
    const { token } = seed(rows);

    await handleAuthRefresh(refreshReq({ token, origin: "https://evil.example" }), options);

    const csrf = inserted.filter(
      (r) =>
        (r.payloadMetadata as Record<string, unknown>).reason ===
        "csrf_origin_mismatch",
    );
    expect(csrf).toHaveLength(1);
    expect(csrf[0]).toMatchObject({
      specialistId: "anonymous",
      actionType: "auth.failure",
      outcome: "FAILED",
      payloadMetadata: { origin: "https://evil.example", method: "POST" },
    });
  });

  it("admits the allowed BFF origin and completes the refresh (200)", async () => {
    const { options, rows } = happyOptions();
    const { token } = seed(rows);

    const res = await handleAuthRefresh(
      refreshReq({ token, origin: ALLOWED_ORIGIN }),
      options,
    );

    expect(res.status).toBe(200);
  });
});
