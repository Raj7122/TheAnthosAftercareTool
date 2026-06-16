import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GET } from "../../../../app/api/v1/auth/login/route";

// Integration test for endpoint E-01: drives the deployed Next.js route handler
// end-to-end — route shim → @anthos/api `handleAuthLogin` → `loadOAuthLoginConfig`
// reading process.env — and asserts the full 302 redirect to a mock Salesforce
// authorize endpoint. No network: /auth/login only BUILDS the redirect URL;
// Salesforce is never contacted by this endpoint. The cookie-decryption
// round-trip is covered at the package level (packages/api/test/auth/login).

const MOCK_SF_LOGIN_URL = "https://mock.my.salesforce.com";
const MOCK_CALLBACK = "https://bff.test/api/v1/auth/callback";
// API §7.2.1 cookie names — asserted as literals here to pin the contract.
const STATE_COOKIE = "anthos_oauth_state";
const PKCE_COOKIE = "anthos_oauth_pkce";

let savedEnv: NodeJS.ProcessEnv;

beforeAll(() => {
  savedEnv = { ...process.env };
  process.env.SF_LOGIN_URL = MOCK_SF_LOGIN_URL;
  process.env.SF_CONNECTED_APP_CONSUMER_KEY = "mock-client-id";
  process.env.SF_OAUTH_REDIRECT_URI = MOCK_CALLBACK;
  // A random key per run — never a hardcoded secret in source.
  process.env.ANTHOS_OAUTH_COOKIE_SECRET = randomBytes(32).toString("base64");
});

afterAll(() => {
  process.env = savedEnv;
});

describe("GET /api/v1/auth/login — route integration (E-01)", () => {
  it("302-redirects to the configured Salesforce authorize endpoint", async () => {
    const res = await GET(new Request("https://bff.test/api/v1/auth/login"));
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("Location") ?? "");
    expect(loc.origin).toBe(MOCK_SF_LOGIN_URL);
    expect(loc.pathname).toBe("/services/oauth2/authorize");
    const q = loc.searchParams;
    expect(q.get("response_type")).toBe("code");
    expect(q.get("client_id")).toBe("mock-client-id");
    expect(q.get("redirect_uri")).toBe(MOCK_CALLBACK);
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("scope")).toBe("api refresh_token");
    expect(q.get("code_challenge")).toBeTruthy();
    expect(q.get("state")).toBeTruthy();
  });

  it("sets Cache-Control: no-store, X-Trace-Id, and the two encrypted OAuth cookies", async () => {
    const res = await GET(new Request("https://bff.test/api/v1/auth/login"));
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Trace-Id")).toBeTruthy();

    const cookies = res.headers.getSetCookie();
    expect(cookies).toHaveLength(2);
    expect(cookies.some((c) => c.startsWith(`${STATE_COOKIE}=`))).toBe(true);
    expect(cookies.some((c) => c.startsWith(`${PKCE_COOKIE}=`))).toBe(true);
    for (const cookie of cookies) {
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("Secure");
      expect(cookie).toContain("SameSite=None");
      expect(cookie).toContain("Path=/api/v1/auth");
    }
  });

  it("rejects an open-redirect returnTo end-to-end with 400 INVALID_QUERY_PARAM", async () => {
    const res = await GET(new Request("https://bff.test/api/v1/auth/login?returnTo=//evilhost"));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("INVALID_QUERY_PARAM");
  });
});
