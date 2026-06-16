import { randomBytes } from "node:crypto";

import {
  aeadDecrypt,
  aeadEncrypt,
  encodePkcePayload,
  encodeStatePayload,
  loadSessionConfig,
  OAUTH_PKCE_COOKIE_NAME,
  OAUTH_STATE_COOKIE_NAME,
} from "@anthos/auth";
import type { CookieAttributes } from "@anthos/auth";
import { RoleResolutionError, SalesforceError } from "@anthos/integrations";
import type { TokenExchangeResult } from "@anthos/integrations";
import type { DbOrTx } from "@anthos/persistence";
import { describe, expect, it, vi } from "vitest";

import type { AuthCallbackConfig } from "../../src/auth/callback-config.js";
import { handleAuthCallback } from "../../src/auth/callback.js";
import type {
  AuthCallbackOptions,
  CodeExchanger,
  SpecialistResolver,
} from "../../src/auth/callback.js";
import type {
  CreateSessionInput,
  SessionRecord,
  SessionStore,
} from "../../src/session/store.js";

// ── fixtures ────────────────────────────────────────────────────────────────

const OAUTH_COOKIE_KEY = randomBytes(32);
const SF_TOKEN_ENC_KEY = randomBytes(32);

// A valid 18-char Salesforce identity URL — `parseSalesforceUserId` runs for
// real (it is not stubbed), so the User Id segment must be Id-shaped.
const SF_USER_ID = "0058K00000XYZAbQAO";
const IDENTITY_URL = `https://login.salesforce.com/id/00D8K000000ABCDUA0/${SF_USER_ID}`;

// The specialist identity the (stubbed) resolver returns — captured from the
// Salesforce User record and persisted on the session row (P1B-05).
const SF_DISPLAY_NAME = "Marie Alcis";
const SF_EMAIL = "malcis@anthoshome.org";
const SF_TIMEZONE = "America/New_York";

const STATE = "state-token-from-login";
const CODE_VERIFIER = "pkce-code-verifier-placeholder-value-1234567890";

const SESSION_COOKIE_IFRAME: CookieAttributes = {
  httpOnly: true,
  secure: true,
  sameSite: "None",
  path: "/",
};

function makeConfig(overrides: Partial<AuthCallbackConfig> = {}): AuthCallbackConfig {
  return {
    loginUrl: "https://example.my.salesforce.com",
    clientId: "client-abc",
    clientSecret: "client-secret-placeholder",
    redirectUri: "https://bff.test/api/v1/auth/callback",
    scope: "api refresh_token",
    oauthCookieKey: OAUTH_COOKIE_KEY,
    oauthCookieSecure: true,
    oauthCookieSameSite: "None",
    sfTokenEncKey: SF_TOKEN_ENC_KEY,
    rolePermissionSets: { Anthos_Aftercare_Specialist: "SPECIALIST" },
    session: loadSessionConfig({}),
    sessionCookie: SESSION_COOKIE_IFRAME,
    ...overrides,
  };
}

function tokenResult(overrides: Partial<TokenExchangeResult> = {}): TokenExchangeResult {
  return {
    accessToken: "00DU8!ACCESS-TOKEN-placeholder",
    refreshToken: "5Aep861-REFRESH-TOKEN-placeholder",
    instanceUrl: "https://example.my.salesforce.com",
    identityUrl: IDENTITY_URL,
    scope: "api refresh_token",
    ...overrides,
  };
}

// In-memory SessionStore — mirrors packages/api/test/session/service.test.ts.
function makeStore(): { store: SessionStore; createInputs: CreateSessionInput[] } {
  const createInputs: CreateSessionInput[] = [];
  let n = 0;
  const store: SessionStore = {
    create(input) {
      createInputs.push(input);
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
      return Promise.resolve(record);
    },
    getByTokenHash: () => Promise.resolve(null),
    getSalesforceRefreshToken: () => Promise.resolve(null),
    touch: () => Promise.resolve(),
    applySessionRefresh: () => Promise.resolve(),
    revoke: () => Promise.resolve(),
    cleanupExpired: () => Promise.resolve(0),
  };
  return { store, createInputs };
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

interface CallbackReqOpts {
  readonly code?: string | null;
  readonly state?: string | null;
  readonly error?: string;
  readonly cookieState?: string;
  readonly returnTo?: string;
  readonly codeVerifier?: string;
  readonly omitStateCookie?: boolean;
  readonly omitPkceCookie?: boolean;
  readonly tamperStateCookie?: boolean;
}

// Build a callback Request with the two encrypted OAuth pre-session cookies
// (exactly as P1B-01 would have set them).
function callbackReq(opts: CallbackReqOpts = {}): Request {
  const url = new URL("https://bff.test/api/v1/auth/callback");
  if (opts.error !== undefined) {
    url.searchParams.set("error", opts.error);
  }
  if (opts.code !== null) {
    url.searchParams.set("code", opts.code ?? "sf-auth-code-placeholder");
  }
  if (opts.state !== null) {
    url.searchParams.set("state", opts.state ?? STATE);
  }

  const statePayload =
    opts.returnTo !== undefined
      ? { state: opts.cookieState ?? STATE, returnTo: opts.returnTo }
      : { state: opts.cookieState ?? STATE };
  const encState = aeadEncrypt(encodeStatePayload(statePayload), OAUTH_COOKIE_KEY);
  const encPkce = aeadEncrypt(
    encodePkcePayload({ codeVerifier: opts.codeVerifier ?? CODE_VERIFIER }),
    OAUTH_COOKIE_KEY,
  );

  const cookies: string[] = [];
  if (opts.omitStateCookie !== true) {
    cookies.push(
      `${OAUTH_STATE_COOKIE_NAME}=${opts.tamperStateCookie === true ? "not-valid-ciphertext" : encState}`,
    );
  }
  if (opts.omitPkceCookie !== true) {
    cookies.push(`${OAUTH_PKCE_COOKIE_NAME}=${encPkce}`);
  }

  const headers = new Headers({ "user-agent": "Mozilla/5.0 (iPad)" });
  if (cookies.length > 0) {
    headers.set("cookie", cookies.join("; "));
  }
  return new Request(url, { method: "GET", headers });
}

// A happy-path options bundle: injected config, store, db, and stubbed SF
// round-trips. Individual tests override pieces.
function happyOptions(
  overrides: Partial<AuthCallbackOptions> = {},
): { options: AuthCallbackOptions; inserted: Record<string, unknown>[]; createInputs: CreateSessionInput[] } {
  const { store, createInputs } = makeStore();
  const { db, inserted } = makeFakeDb();
  const exchangeCode: CodeExchanger = () => Promise.resolve(tokenResult());
  const resolveSpecialist: SpecialistResolver = () =>
    Promise.resolve({
      role: "SPECIALIST",
      displayName: SF_DISPLAY_NAME,
      email: SF_EMAIL,
      timezone: SF_TIMEZONE,
    });
  return {
    options: {
      config: makeConfig(),
      store,
      db,
      exchangeCode,
      resolveSpecialist,
      ...overrides,
    },
    inserted,
    createInputs,
  };
}

function setCookieValues(res: Response): string[] {
  return res.headers.getSetCookie();
}

function cookieByName(cookies: string[], name: string): string {
  const match = cookies.find((c) => c.startsWith(`${name}=`));
  if (match === undefined) {
    throw new Error(`Set-Cookie for ${name} not found`);
  }
  return match;
}

// ── happy path ──────────────────────────────────────────────────────────────

describe("handleAuthCallback — success (E-02)", () => {
  it("302-redirects to the caseload landing with the anthos_session cookie", async () => {
    const { options } = happyOptions();
    const res = await handleAuthCallback(callbackReq(), options);

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Trace-Id")).toBeTruthy();

    const session = cookieByName(setCookieValues(res), "anthos_session");
    expect(session).toContain("HttpOnly");
    expect(session).toContain("Secure");
    expect(session).toContain("SameSite=None");
    expect(session).toContain("Path=/");
    // Max-Age tracks the idle timeout (30 min default — API §7.2.2).
    expect(session).toContain("Max-Age=1800");
  });

  it("clears both OAuth pre-session cookies on the login path", async () => {
    const { options } = happyOptions();
    const res = await handleAuthCallback(callbackReq(), options);
    const cookies = setCookieValues(res);

    for (const name of [OAUTH_STATE_COOKIE_NAME, OAUTH_PKCE_COOKIE_NAME]) {
      const cleared = cookieByName(cookies, name);
      expect(cleared).toContain("Max-Age=0");
      expect(cleared).toContain("Path=/api/v1/auth");
    }
  });

  it("writes the auth.session_start audit row (session id + role, trace id)", async () => {
    const { options, inserted } = happyOptions({ logger: undefined });
    const req = callbackReq();
    const res = await handleAuthCallback(req, options);

    expect(res.status).toBe(302);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.actionType).toBe("auth.session_start");
    expect(inserted[0]?.outcome).toBe("SUCCESS");
    expect(inserted[0]?.specialistId).toBe(SF_USER_ID);
    expect(inserted[0]?.payloadMetadata).toEqual({
      session_id: "session-1",
      role: "SPECIALIST",
    });
  });

  it("persists the SF refresh token encrypted — decryptable, never plaintext", async () => {
    const { options, createInputs } = happyOptions();
    const res = await handleAuthCallback(callbackReq(), options);

    const stored = createInputs[0]?.sfRefreshTokenEncrypted;
    expect(typeof stored).toBe("string");
    // Round-trips back to the original refresh token under the at-rest key …
    expect(aeadDecrypt(stored as string, SF_TOKEN_ENC_KEY)).toBe(
      "5Aep861-REFRESH-TOKEN-placeholder",
    );
    // … and the plaintext token never rides the response or a cookie.
    const serialized = [
      res.headers.get("Location") ?? "",
      ...setCookieValues(res),
    ].join("\n");
    expect(serialized).not.toContain("5Aep861-REFRESH-TOKEN-placeholder");
  });

  it("records the specialist id, role, identity, and user-agent hash on the session row", async () => {
    const { options, createInputs } = happyOptions();
    await handleAuthCallback(callbackReq(), options);

    expect(createInputs[0]?.specialistId).toBe(SF_USER_ID);
    expect(createInputs[0]?.role).toBe("SPECIALIST");
    expect(createInputs[0]?.userAgentHash).toMatch(/^[a-f0-9]{64}$/);
    // P1B-05 — the Salesforce User identity rides onto the session row so
    // `GET /me` (E-05) can read it back without a Salesforce round-trip.
    expect(createInputs[0]?.displayName).toBe(SF_DISPLAY_NAME);
    expect(createInputs[0]?.email).toBe(SF_EMAIL);
    expect(createInputs[0]?.timezone).toBe(SF_TIMEZONE);
  });

  it("honors a valid returnTo from the decrypted state cookie", async () => {
    const { options } = happyOptions();
    const res = await handleAuthCallback(
      callbackReq({ returnTo: "/calibration/abc" }),
      options,
    );
    expect(res.headers.get("Location")).toBe("/calibration/abc");
  });

  it("falls back to / when the cookie returnTo is an open-redirect payload", async () => {
    const { options } = happyOptions();
    const res = await handleAuthCallback(
      callbackReq({ returnTo: "//evilhost" }),
      options,
    );
    expect(res.headers.get("Location")).toBe("/");
  });
});

// ── pre-identity failures (structured-log only, no audit row) ───────────────

describe("handleAuthCallback — pre-identity failures redirect, never audit", () => {
  it("redirects ?error=access_denied to the SPA with authError=oauth_denied", async () => {
    const { options, inserted } = happyOptions();
    const res = await handleAuthCallback(
      callbackReq({ error: "access_denied" }),
      options,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/?authError=oauth_denied");
    expect(inserted).toHaveLength(0);
  });

  it("returns 400 INVALID_QUERY_PARAM (JSON) when code is absent", async () => {
    const { options } = happyOptions();
    const res = await handleAuthCallback(callbackReq({ code: null }), options);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; details: { param: string } };
    expect(body.code).toBe("INVALID_QUERY_PARAM");
    expect(body.details.param).toBe("code");
  });

  it("returns 400 INVALID_QUERY_PARAM (JSON) when state is absent", async () => {
    const { options } = happyOptions();
    const res = await handleAuthCallback(callbackReq({ state: null }), options);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { details: { param: string } }).details.param).toBe(
      "state",
    );
  });

  it("redirects with authError=oauth_failed when an OAuth cookie is absent", async () => {
    const { options, inserted } = happyOptions();
    const res = await handleAuthCallback(
      callbackReq({ omitPkceCookie: true }),
      options,
    );
    expect(res.headers.get("Location")).toBe("/?authError=oauth_failed");
    expect(inserted).toHaveLength(0);
  });

  it("redirects with authError=oauth_failed when an OAuth cookie is tampered", async () => {
    const { options } = happyOptions();
    const res = await handleAuthCallback(
      callbackReq({ tamperStateCookie: true }),
      options,
    );
    expect(res.headers.get("Location")).toBe("/?authError=oauth_failed");
  });

  it("redirects with authError=oauth_failed on a state mismatch (no audit row)", async () => {
    const { options, inserted } = happyOptions();
    const res = await handleAuthCallback(
      callbackReq({ state: "forged-state", cookieState: STATE }),
      options,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/?authError=oauth_failed");
    // Every E-02 response carries the no-store + trace headers (API §8.5 / §14.4).
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Trace-Id")).toBeTruthy();
    expect(inserted).toHaveLength(0);
  });

  it("redirects with authError=oauth_failed on an invalid_grant code exchange", async () => {
    const { options, inserted } = happyOptions({
      exchangeCode: () =>
        Promise.reject(new SalesforceError("SF_AUTH_FAILED", "invalid_grant")),
    });
    const res = await handleAuthCallback(callbackReq(), options);
    expect(res.headers.get("Location")).toBe("/?authError=oauth_failed");
    expect(inserted).toHaveLength(0);
  });

  it("redirects with authError=sf_unavailable on a code-exchange network timeout", async () => {
    const { options } = happyOptions({
      exchangeCode: () =>
        Promise.reject(new SalesforceError("SF_NETWORK_TIMEOUT", "timed out")),
    });
    const res = await handleAuthCallback(callbackReq(), options);
    expect(res.headers.get("Location")).toBe("/?authError=sf_unavailable");
  });

  it("redirects with authError=oauth_failed when the granted scope is too narrow", async () => {
    const { options } = happyOptions({
      // `refresh_token` requested but not granted — a BR-01 violation.
      exchangeCode: () => Promise.resolve(tokenResult({ scope: "api" })),
    });
    const res = await handleAuthCallback(callbackReq(), options);
    expect(res.headers.get("Location")).toBe("/?authError=oauth_failed");
  });

  it("treats an empty granted scope as a soft pass (RFC 6749 §5.1 — scope field is optional)", async () => {
    // Salesforce may omit `scope` when it equals the request; an empty string
    // is not "narrowed" and must not fail the exchange.
    const { options } = happyOptions({
      exchangeCode: () => Promise.resolve(tokenResult({ scope: "" })),
    });
    const res = await handleAuthCallback(callbackReq(), options);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/");
  });
});

// ── post-identity failures (auth.failure audit row written first) ───────────

describe("handleAuthCallback — post-identity failures audit before responding", () => {
  it("redirects authError=not_provisioned + audits a permission_set_missing failure", async () => {
    const { options, inserted } = happyOptions({
      resolveSpecialist: () =>
        Promise.reject(
          new RoleResolutionError("PERMISSION_SET_MISSING", "no role perm set"),
        ),
    });
    const res = await handleAuthCallback(callbackReq(), options);

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/?authError=not_provisioned");
    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.actionType).toBe("auth.failure");
    expect(inserted[0]?.outcome).toBe("FAILED");
    expect(inserted[0]?.specialistId).toBe(SF_USER_ID);
    expect(inserted[0]?.payloadMetadata).toEqual({ reason: "permission_set_missing" });
  });

  it("redirects authError=sf_unavailable + audits a specialist-query failure", async () => {
    const { options, inserted } = happyOptions({
      resolveSpecialist: () => Promise.reject(new Error("SF_NETWORK_TIMEOUT")),
    });
    const res = await handleAuthCallback(callbackReq(), options);

    expect(res.headers.get("Location")).toBe("/?authError=sf_unavailable");
    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.actionType).toBe("auth.failure");
    expect(inserted[0]?.payloadMetadata).toEqual({
      reason: "sf_specialist_query_failed",
    });
  });

  it("redirects authError=oauth_failed when the SF identity URL is unparseable", async () => {
    const { options, inserted } = happyOptions({
      exchangeCode: () =>
        Promise.resolve(tokenResult({ identityUrl: "https://login.salesforce.com/id/x" })),
    });
    const res = await handleAuthCallback(callbackReq(), options);
    // The id is not yet known — structured-log only, no audit row.
    expect(res.headers.get("Location")).toBe("/?authError=oauth_failed");
    expect(inserted).toHaveLength(0);
  });
});

// ── config failure ──────────────────────────────────────────────────────────

describe("handleAuthCallback — config failure", () => {
  it("returns 500 AUTH_CONFIG_ERROR when env config is missing, leaking no value", async () => {
    const saved = { ...process.env };
    delete process.env.SF_LOGIN_URL;
    delete process.env.SF_CONNECTED_APP_CONSUMER_KEY;
    delete process.env.SF_CONNECTED_APP_CONSUMER_SECRET;
    delete process.env.SF_OAUTH_REDIRECT_URI;
    delete process.env.ANTHOS_OAUTH_COOKIE_SECRET;
    delete process.env.ANTHOS_SF_TOKEN_ENC_KEY;
    delete process.env.ANTHOS_ROLE_PERMISSION_SETS;
    try {
      const res = await handleAuthCallback(callbackReq());
      expect(res.status).toBe(500);
      const body = (await res.json()) as { code: string; message: string };
      expect(body.code).toBe("AUTH_CONFIG_ERROR");
      expect(body.message).not.toContain("SF_LOGIN_URL");
    } finally {
      process.env = saved;
    }
  });
});

// ── secrecy ─────────────────────────────────────────────────────────────────

describe("handleAuthCallback — secrecy", () => {
  it("never logs the code, code_verifier, tokens, or raw cookie values", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { options } = happyOptions();
      const req = callbackReq({ code: "secret-auth-code-xyz" });
      const cookieHeader = req.headers.get("cookie") ?? "";
      const res = await handleAuthCallback(req, options);
      const logged = [...log.mock.calls, ...warn.mock.calls, ...error.mock.calls]
        .map((call) => String(call[0]))
        .join("\n");

      expect(res.status).toBe(302);
      // The benign breadcrumb fired …
      expect(logged).toContain("oauth_callback_session_started");
      // … but no secret material reached the log stream.
      expect(logged).not.toContain("secret-auth-code-xyz");
      expect(logged).not.toContain(CODE_VERIFIER);
      expect(logged).not.toContain("00DU8!ACCESS-TOKEN-placeholder");
      expect(logged).not.toContain("5Aep861-REFRESH-TOKEN-placeholder");
      for (const cookie of cookieHeader.split("; ")) {
        const value = cookie.slice(cookie.indexOf("=") + 1);
        expect(logged).not.toContain(value);
      }
    } finally {
      log.mockRestore();
      warn.mockRestore();
      error.mockRestore();
    }
  });
});
