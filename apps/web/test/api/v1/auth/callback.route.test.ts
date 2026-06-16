import { randomBytes } from "node:crypto";

import { handleAuthCallback, handleAuthLogin } from "@anthos/api";
import type { AuthCallbackOptions } from "@anthos/api";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { GET } from "../../../../app/api/v1/auth/callback/route";

// Integration test for endpoint E-02. Two layers:
//  1. The Next.js route shim is driven end-to-end for the failure paths that
//     return BEFORE touching the DB or Salesforce (malformed request, upstream
//     `?error=`, absent OAuth cookie) — proving the shim → `@anthos/api` wiring.
//  2. The happy path drives `handleAuthCallback` directly with an in-memory
//     session store + a mock `fetchImpl`, exercising the REAL code-exchange,
//     the REAL permission-set SOQL, and the REAL encrypted-cookie round-trip:
//     the OAuth cookies are minted by actually running `handleAuthLogin`, so
//     the genuine login → callback `state` / PKCE chain is what is tested.

const MOCK_SF_LOGIN_URL = "https://mock.my.salesforce.com";
const MOCK_INSTANCE_URL = "https://mock-instance.my.salesforce.com";
const MOCK_CALLBACK = "https://bff.test/api/v1/auth/callback";
const SF_USER_ID = "0058K00000XYZAbQAO";

let savedEnv: NodeJS.ProcessEnv;

beforeAll(() => {
  savedEnv = { ...process.env };
  process.env.SF_LOGIN_URL = MOCK_SF_LOGIN_URL;
  process.env.SF_CONNECTED_APP_CONSUMER_KEY = "mock-client-id";
  process.env.SF_CONNECTED_APP_CONSUMER_SECRET = "mock-client-secret";
  process.env.SF_OAUTH_REDIRECT_URI = MOCK_CALLBACK;
  // Random keys per run — never a hardcoded secret in source.
  process.env.ANTHOS_OAUTH_COOKIE_SECRET = randomBytes(32).toString("base64");
  process.env.ANTHOS_SF_TOKEN_ENC_KEY = randomBytes(32).toString("base64");
  process.env.ANTHOS_ROLE_PERMISSION_SETS = JSON.stringify({
    Anthos_Aftercare_Specialist: "SPECIALIST",
  });
  // Exercise the deployed iframe cookie policy (SameSite=None; Secure).
  process.env.ANTHOS_SESSION_COOKIE_SAMESITE = "None";
  process.env.ANTHOS_SESSION_COOKIE_SECURE = "true";
});

afterAll(() => {
  process.env = savedEnv;
});

// Mint the two encrypted OAuth pre-session cookies the way P1B-01 would, and
// return them alongside the `state` behind the login redirect.
async function mintLoginCookies(): Promise<{ cookieHeader: string; state: string }> {
  const res = await handleAuthLogin(new Request("https://bff.test/api/v1/auth/login"));
  const state = new URL(res.headers.get("Location") ?? "").searchParams.get("state");
  if (state === null) {
    throw new Error("login redirect carried no state");
  }
  // Re-serialize the Set-Cookie values as an inbound Cookie header.
  const cookieHeader = res.headers
    .getSetCookie()
    .map((c) => c.slice(0, c.indexOf(";")))
    .join("; ");
  return { cookieHeader, state };
}

// A `fetch` stand-in answering the two Salesforce round-trips: the
// `authorization_code` token exchange and the `PermissionSetAssignment` SOQL.
function mockSalesforce(opts: {
  tokenStatus?: number;
  tokenBody?: string;
  permissionSet?: string;
}): typeof fetch {
  const fn = vi.fn(async (input: string | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/services/oauth2/token")) {
      return {
        ok: (opts.tokenStatus ?? 200) < 400,
        status: opts.tokenStatus ?? 200,
        text: async () =>
          opts.tokenBody ??
          JSON.stringify({
            access_token: "00DU8!ACCESS",
            refresh_token: "5Aep861-REFRESH",
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
            records: [
              { PermissionSet: { Name: opts.permissionSet ?? "Anthos_Aftercare_Specialist" } },
            ],
          }),
      };
    }
    throw new Error(`unexpected fetch to ${url}`);
  });
  return fn as unknown as typeof fetch;
}

// In-memory SessionStore + a fake DB handle for the audit-writer insert chain.
function makeDeps(): {
  options: Pick<AuthCallbackOptions, "store" | "db">;
  inserted: Record<string, unknown>[];
  createdSfRefreshToken: () => string | undefined;
} {
  const inserted: Record<string, unknown>[] = [];
  let storedRefresh: string | undefined;
  const store: NonNullable<AuthCallbackOptions["store"]> = {
    create(input) {
      storedRefresh = input.sfRefreshTokenEncrypted;
      return Promise.resolve({
        id: "session-1",
        specialistId: input.specialistId,
        role: input.role,
        lastActivityAt: new Date(),
        expiresAt: input.expiresAt,
        revoked: false,
        displayName: input.displayName ?? null,
        email: input.email ?? null,
        timezone: input.timezone ?? null,
      });
    },
    getByTokenHash: () => Promise.resolve(null),
    getSalesforceRefreshToken: () => Promise.resolve(null),
    touch: () => Promise.resolve(),
    applySessionRefresh: () => Promise.resolve(),
    revoke: () => Promise.resolve(),
    cleanupExpired: () => Promise.resolve(0),
  };
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
  return {
    options: { store, db: db as unknown as NonNullable<AuthCallbackOptions["db"]> },
    inserted,
    createdSfRefreshToken: () => storedRefresh,
  };
}

describe("GET /api/v1/auth/callback — route shim, DB-free failure paths (E-02)", () => {
  it("returns 400 INVALID_QUERY_PARAM when code is absent", async () => {
    const res = await GET(new Request(`${MOCK_CALLBACK}?state=abc`));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("INVALID_QUERY_PARAM");
  });

  it("302-redirects an upstream ?error= to the SPA with authError=oauth_denied", async () => {
    const res = await GET(new Request(`${MOCK_CALLBACK}?error=access_denied`));
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/?authError=oauth_denied");
  });

  it("302-redirects authError=oauth_failed when the OAuth cookies are absent", async () => {
    const res = await GET(new Request(`${MOCK_CALLBACK}?code=abc&state=xyz`));
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/?authError=oauth_failed");
  });
});

describe("GET /api/v1/auth/callback — full OAuth round-trip (E-02)", () => {
  it("completes the exchange: 302 to /, session cookie, OAuth cookies cleared, audited", async () => {
    const { cookieHeader, state } = await mintLoginCookies();
    const { options, inserted, createdSfRefreshToken } = makeDeps();

    const req = new Request(`${MOCK_CALLBACK}?code=sf-auth-code&state=${state}`, {
      headers: { cookie: cookieHeader, "user-agent": "Mozilla/5.0 (iPad)" },
    });
    const res = await handleAuthCallback(req, {
      ...options,
      fetchImpl: mockSalesforce({}),
    });

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/");

    const cookies = res.headers.getSetCookie();
    const session = cookies.find((c) => c.startsWith("anthos_session="));
    expect(session).toBeDefined();
    expect(session).toContain("HttpOnly");
    expect(session).toContain("SameSite=None");
    expect(session).toContain("Max-Age=1800");
    // Both single-use OAuth cookies are cleared.
    expect(cookies.some((c) => c.startsWith("anthos_oauth_state=") && c.includes("Max-Age=0"))).toBe(
      true,
    );
    expect(cookies.some((c) => c.startsWith("anthos_oauth_pkce=") && c.includes("Max-Age=0"))).toBe(
      true,
    );

    // The auth.session_start audit row was written (before the 302).
    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.actionType).toBe("auth.session_start");
    expect(inserted[0]?.specialistId).toBe(SF_USER_ID);
    // The refresh token was persisted server-side, never in the response.
    expect(typeof createdSfRefreshToken()).toBe("string");
    expect(cookies.join("\n")).not.toContain("5Aep861-REFRESH");
  });

  it("302-redirects authError=oauth_failed when Salesforce rejects the code (invalid_grant)", async () => {
    const { cookieHeader, state } = await mintLoginCookies();
    const { options, inserted } = makeDeps();

    const req = new Request(`${MOCK_CALLBACK}?code=stale-code&state=${state}`, {
      headers: { cookie: cookieHeader },
    });
    const res = await handleAuthCallback(req, {
      ...options,
      fetchImpl: mockSalesforce({
        tokenStatus: 400,
        tokenBody: JSON.stringify({ error: "invalid_grant" }),
      }),
    });

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/?authError=oauth_failed");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Trace-Id")).toBeTruthy();
    // No specialist id was established — no audit row.
    expect(inserted).toHaveLength(0);
  });
});
