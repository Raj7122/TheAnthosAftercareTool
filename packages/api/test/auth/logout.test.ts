import { randomUUID } from "node:crypto";

import { hashToken, mintToken } from "@anthos/auth";
import type { CookieAttributes, Role } from "@anthos/auth";
import type { DbOrTx } from "@anthos/persistence";
import { describe, expect, it, vi } from "vitest";

import { handleAuthLogout } from "../../src/auth/logout.js";
import type { AuthLogoutOptions } from "../../src/auth/logout.js";
import type { AuthLogoutConfig } from "../../src/auth/logout-config.js";
import type {
  IdempotencyRecord,
  IdempotencyStatus,
  IdempotencyStore,
} from "../../src/idempotency/store.js";
import type { SessionRecord, SessionStore } from "../../src/session/store.js";

// ── fixtures ────────────────────────────────────────────────────────────────

// The stored Salesforce refresh-token ciphertext — a placeholder, since logout
// decrypts nothing; the test only checks the column is wiped on revoke.
const STORED_REFRESH_CIPHERTEXT = "ciphertext-STORED-REFRESH-placeholder";

const SESSION_COOKIE_IFRAME: CookieAttributes = {
  httpOnly: true,
  secure: true,
  sameSite: "None",
  path: "/",
};

function makeConfig(overrides: Partial<AuthLogoutConfig> = {}): AuthLogoutConfig {
  return { sessionCookie: SESSION_COOKIE_IFRAME, ...overrides };
}

interface FakeSession {
  id: string;
  specialistId: string;
  role: Role;
  lastActivityAt: Date;
  expiresAt: Date;
  revoked: boolean;
  revocationReason: string | null;
  sfRefreshTokenEncrypted: string | null;
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

// In-memory SessionStore holding real rows so `revokeSession` resolves them.
// `revoke` mirrors the real Postgres repo: it flips `revoked` AND nulls the
// stored Salesforce refresh token.
function makeSessionStore(): {
  store: SessionStore;
  rows: Map<string, FakeSession>;
} {
  const rows = new Map<string, FakeSession>();
  const store: SessionStore = {
    create() {
      return Promise.reject(new Error("create not used in logout tests"));
    },
    getByTokenHash(tokenHash) {
      const row = rows.get(tokenHash);
      return Promise.resolve(row ? toRecord(row) : null);
    },
    getSalesforceRefreshToken() {
      return Promise.reject(
        new Error("getSalesforceRefreshToken not used in logout tests"),
      );
    },
    touch() {
      return Promise.reject(new Error("touch not used in logout tests"));
    },
    applySessionRefresh() {
      return Promise.reject(new Error("applySessionRefresh not used in logout tests"));
    },
    revoke(tokenHash, reason) {
      const row = rows.get(tokenHash);
      if (row) {
        row.revoked = true;
        row.revocationReason = reason;
        row.sfRefreshTokenEncrypted = null;
      }
      return Promise.resolve();
    },
    cleanupExpired() {
      return Promise.resolve(0);
    },
  };
  return { store, rows };
}

// In-memory IdempotencyStore — mirrors packages/api/test/auth/refresh.test.ts.
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
  revoked?: boolean;
  sfRefreshTokenEncrypted?: string | null;
}

// Seed a session row and return its plaintext cookie token + token hash.
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
    lastActivityAt: new Date(),
    expiresAt: new Date(Date.now() + 11 * 60 * 60 * 1000),
    revoked: opts.revoked ?? false,
    revocationReason: opts.revoked === true ? "idle_timeout" : null,
    sfRefreshTokenEncrypted:
      opts.sfRefreshTokenEncrypted === undefined
        ? STORED_REFRESH_CIPHERTEXT
        : opts.sfRefreshTokenEncrypted,
  });
  return { token, tokenHash, sessionId };
}

// The BFF's own origin — same host as the request URL below. P1B-06's Origin
// check accepts it; tests pass `origin: "https://evil.example"` or
// `origin: null` to exercise the CSRF rejection path.
const ALLOWED_ORIGIN = "https://bff.test";

function logoutReq(
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
  return new Request("https://bff.test/api/v1/auth/logout", {
    method: "POST",
    headers,
  });
}

// A happy-path options bundle. Individual tests override pieces.
function makeOptions(overrides: Partial<AuthLogoutOptions> = {}): {
  options: AuthLogoutOptions;
  rows: Map<string, FakeSession>;
  inserted: Record<string, unknown>[];
} {
  const { store, rows } = makeSessionStore();
  const { db, inserted } = makeFakeDb();
  return {
    options: {
      config: makeConfig(),
      store,
      db,
      idempotencyStore: makeIdempotencyStore(),
      originConfig: { allowedOrigins: [ALLOWED_ORIGIN] },
      ...overrides,
    },
    rows,
    inserted,
  };
}

function sessionEndRows(inserted: Record<string, unknown>[]): Record<string, unknown>[] {
  return inserted.filter((r) => r.actionType === "auth.session_end");
}

function clearedSessionCookie(res: Response): string | undefined {
  return res.headers.getSetCookie().find((c) => c.startsWith("anthos_session="));
}

// ── graceful no-op (absent / unknown session) ───────────────────────────────

describe("handleAuthLogout — graceful no-op (E-04)", () => {
  it("204 + cleared cookie when the anthos_session cookie is absent — no audit", async () => {
    const { options, inserted } = makeOptions();

    // No Idempotency-Key header at all — the no-op path must NOT require one
    // (nothing is mutated and no audit row is written).
    const res = await handleAuthLogout(logoutReq({ token: null, key: null }), options);

    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Trace-Id")).toBeTruthy();
    const cookie = clearedSessionCookie(res);
    expect(cookie).toContain("anthos_session=;");
    expect(cookie).toContain("Max-Age=0");
    expect(inserted).toHaveLength(0);
  });

  it("204 + cleared cookie when no session matches the cookie token — no audit", async () => {
    const { options, inserted } = makeOptions();

    const res = await handleAuthLogout(logoutReq({ token: mintToken(), key: null }), options);

    expect(res.status).toBe(204);
    expect(clearedSessionCookie(res)).toContain("Max-Age=0");
    expect(inserted).toHaveLength(0);
  });
});

// ── active-session logout ───────────────────────────────────────────────────

describe("handleAuthLogout — active session (E-04)", () => {
  it("204, revokes the session, wipes the SF refresh token, clears the cookie", async () => {
    const { options, rows } = makeOptions();
    const { token, tokenHash } = seed(rows);

    const res = await handleAuthLogout(logoutReq({ token }), options);

    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(rows.get(tokenHash)?.revoked).toBe(true);
    expect(rows.get(tokenHash)?.revocationReason).toBe("logout");
    // Immutable #3 — a revoked session retains no usable Salesforce credential.
    expect(rows.get(tokenHash)?.sfRefreshTokenEncrypted).toBeNull();

    // The cleared cookie carries the SAME attributes the callback (P1B-02) set.
    const cookie = clearedSessionCookie(res);
    expect(cookie).toContain("anthos_session=;");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("SameSite=None");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("Max-Age=0");
  });

  it("writes one auth.session_end audit row — session id + role + reason, trace id, no PII", async () => {
    const { options, rows, inserted } = makeOptions();
    const { token, sessionId } = seed(rows);

    const res = await handleAuthLogout(
      logoutReq({ token, traceId: "trace-logout-ok" }),
      options,
    );

    expect(res.status).toBe(204);
    const ends = sessionEndRows(inserted);
    expect(ends).toHaveLength(1);
    expect(ends[0]?.outcome).toBe("SUCCESS");
    expect(ends[0]?.traceId).toBe("trace-logout-ok");
    expect(ends[0]?.payloadMetadata).toEqual({
      session_id: sessionId,
      role: "SPECIALIST",
      reason: "logout",
    });
  });
});

// ── already-terminated session (no duplicate emission) ──────────────────────

describe("handleAuthLogout — already-terminated session", () => {
  it("204 + cleared cookie, but writes NO duplicate auth.session_end", async () => {
    const { options, rows, inserted } = makeOptions();
    const { token } = seed(rows, { revoked: true });

    const res = await handleAuthLogout(logoutReq({ token }), options);

    expect(res.status).toBe(204);
    expect(clearedSessionCookie(res)).toContain("Max-Age=0");
    // The session was already revoked — logout is graceful but emits no audit.
    expect(sessionEndRows(inserted)).toHaveLength(0);
  });

  it("two logouts with different keys emit exactly one auth.session_end", async () => {
    const { options, rows, inserted } = makeOptions();
    const { token } = seed(rows);

    const first = await handleAuthLogout(logoutReq({ token }), options);
    const second = await handleAuthLogout(logoutReq({ token }), options);

    expect(first.status).toBe(204);
    expect(second.status).toBe(204);
    expect(sessionEndRows(inserted)).toHaveLength(1);
  });
});

// ── idempotency (Pattern D / Immutable #6) ──────────────────────────────────

describe("handleAuthLogout — idempotency", () => {
  it("400 IDEMPOTENCY_KEY_REQUIRED when the header is absent on the mutating path", async () => {
    const { options, rows, inserted } = makeOptions();
    const { token } = seed(rows);

    const res = await handleAuthLogout(logoutReq({ token, key: null }), options);

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "IDEMPOTENCY_KEY_REQUIRED" });
    // The core never ran — no revoke, no audit.
    expect(sessionEndRows(inserted)).toHaveLength(0);
  });

  it("replays the cached 204 without re-running the revoke or re-auditing", async () => {
    const { options, rows, inserted } = makeOptions();
    const { token, tokenHash } = seed(rows);
    const key = randomUUID();

    const first = await handleAuthLogout(logoutReq({ token, key }), options);
    const replay = await handleAuthLogout(logoutReq({ token, key }), options);

    expect(first.status).toBe(204);
    expect(replay.status).toBe(204);
    expect(replay.headers.get("X-Idempotent-Replay")).toBe("true");
    // The core ran exactly once: one revoke, one audit row.
    expect(rows.get(tokenHash)?.revoked).toBe(true);
    expect(sessionEndRows(inserted)).toHaveLength(1);

    // The FIRST response clears the cookie. The cached replay carries only the
    // stored status + body — Pattern D `cachedReplayResponse` does not persist
    // response headers — so it does NOT re-send `Set-Cookie`. Benign: the first
    // response already cleared the cookie client-side, and any stale cookie
    // resolves to an unknown token (graceful no-op / 401) on the next request.
    expect(clearedSessionCookie(first)).toContain("Max-Age=0");
    expect(clearedSessionCookie(replay)).toBeUndefined();
  });
});

// ── internal failure (no silent catch) ──────────────────────────────────────

describe("handleAuthLogout — unexpected failure", () => {
  it("500 INTERNAL_ERROR when the session store throws — failure is surfaced", async () => {
    const { store } = makeSessionStore();
    const { db } = makeFakeDb();
    const failingStore: SessionStore = {
      ...store,
      getByTokenHash: () => Promise.reject(new Error("db connection lost")),
    };

    const res = await handleAuthLogout(logoutReq({ token: mintToken() }), {
      config: makeConfig(),
      store: failingStore,
      db,
      idempotencyStore: makeIdempotencyStore(),
      originConfig: { allowedOrigins: [ALLOWED_ORIGIN] },
    });

    expect(res.status).toBe(500);
    // A runtime fault → catalog `INTERNAL_ERROR`, not the operator-error code.
    expect(await res.json()).toMatchObject({ code: "INTERNAL_ERROR" });
  });
});

// ── secrecy (no token in the response or logs) ──────────────────────────────

describe("handleAuthLogout — secrecy", () => {
  it("never leaks the raw session token to the response or logs", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { options, rows } = makeOptions();
      const { token } = seed(rows);

      const res = await handleAuthLogout(logoutReq({ token }), options);
      const serialized = [
        await res.clone().text(),
        ...res.headers.getSetCookie(),
        res.headers.get("X-Trace-Id") ?? "",
      ].join("\n");
      const logged = [
        ...log.mock.calls,
        ...info.mock.calls,
        ...warn.mock.calls,
        ...error.mock.calls,
      ]
        .map((call) => JSON.stringify(call))
        .join("\n");

      expect(res.status).toBe(204);
      expect(serialized).not.toContain(token);
      expect(logged).not.toContain(token);
    } finally {
      log.mockRestore();
      info.mockRestore();
      warn.mockRestore();
      error.mockRestore();
    }
  });
});

// ── CSRF Origin validation (P1B-06 / API §8.6 / SEC-THREAT-1) ───────────────

describe("handleAuthLogout — Origin validation", () => {
  it("rejects a mismatched Origin with 403 CSRF_ORIGIN_MISMATCH before any revoke", async () => {
    const { options, rows, inserted } = makeOptions();
    const { token } = seed(rows);

    const res = await handleAuthLogout(
      logoutReq({ token, origin: "https://evil.example" }),
      options,
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "CSRF_ORIGIN_MISMATCH" });
    // The session was never revoked and no auth.session_end row was written —
    // the CSRF gate runs ahead of the cookie parse and the idempotency lock.
    expect(rows.get(hashToken(token))?.revoked).toBe(false);
    expect(sessionEndRows(inserted)).toHaveLength(0);
  });

  it("rejects an absent Origin on the POST", async () => {
    const { options } = makeOptions();
    const res = await handleAuthLogout(
      logoutReq({ token: null, key: null, origin: null }),
      options,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "CSRF_ORIGIN_MISMATCH" });
  });

  it("writes one auth.failure / csrf_origin_mismatch audit row BEFORE the 403 — sentinel actor, no PII", async () => {
    const { options, rows, inserted } = makeOptions();
    const { token } = seed(rows);

    await handleAuthLogout(logoutReq({ token, origin: "https://evil.example" }), options);

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

  it("admits the allowed BFF origin and completes the logout (204)", async () => {
    const { options, rows } = makeOptions();
    const { token } = seed(rows);

    const res = await handleAuthLogout(
      logoutReq({ token, origin: ALLOWED_ORIGIN }),
      options,
    );

    expect(res.status).toBe(204);
    expect(rows.get(hashToken(token))?.revoked).toBe(true);
  });
});
