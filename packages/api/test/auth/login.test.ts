import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  aeadDecrypt,
  decodePkcePayload,
  decodeStatePayload,
  deriveCodeChallenge,
  OAUTH_PKCE_COOKIE_NAME,
  OAUTH_STATE_COOKIE_NAME,
} from "@anthos/auth";

import type { OAuthLoginConfig } from "../../src/auth/config.js";
import { handleAuthLogin } from "../../src/auth/login.js";

// A test cookie key (random per run) + a config injected straight into the
// handler — Salesforce is never contacted; the handler only builds a URL.
const COOKIE_KEY = randomBytes(32);

const TEST_CONFIG: OAuthLoginConfig = {
  loginUrl: "https://example.my.salesforce.com",
  clientId: "client-abc",
  redirectUri: "https://bff.test/api/v1/auth/callback",
  scope: "api refresh_token",
  cookieKey: COOKIE_KEY,
  cookieSecure: true,
  cookieSameSite: "None",
  cookieMaxAgeSeconds: 300,
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function loginReq(opts: { returnTo?: string; traceId?: string } = {}): Request {
  const url = new URL("https://bff.test/api/v1/auth/login");
  if (opts.returnTo !== undefined) {
    url.searchParams.set("returnTo", opts.returnTo);
  }
  const headers = new Headers();
  if (opts.traceId !== undefined) {
    headers.set("X-Trace-Id", opts.traceId);
  }
  return new Request(url, { method: "GET", headers });
}

// The raw (still-encrypted) value of a named Set-Cookie.
function cookieValue(cookies: string[], name: string): string {
  const match = cookies.find((c) => c.startsWith(`${name}=`));
  if (match === undefined) {
    throw new Error(`Set-Cookie for ${name} not found`);
  }
  return match.slice(name.length + 1, match.indexOf(";"));
}

describe("handleAuthLogin — 302 redirect to Salesforce (E-01)", () => {
  it("returns 302 to the authorize URL with all six OAuth params", async () => {
    const res = await handleAuthLogin(loginReq(), { config: TEST_CONFIG });
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("Location") ?? "");
    expect(loc.origin).toBe("https://example.my.salesforce.com");
    expect(loc.pathname).toBe("/services/oauth2/authorize");
    const q = loc.searchParams;
    expect(q.get("response_type")).toBe("code");
    expect(q.get("client_id")).toBe("client-abc");
    expect(q.get("redirect_uri")).toBe("https://bff.test/api/v1/auth/callback");
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("code_challenge")).toBeTruthy();
    expect(q.get("state")).toBeTruthy();
    expect(q.get("scope")).toBe("api refresh_token");
  });

  it("sets Cache-Control: no-store and echoes an inbound X-Trace-Id", async () => {
    const res = await handleAuthLogin(loginReq({ traceId: "trace-inbound-1" }), {
      config: TEST_CONFIG,
    });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Trace-Id")).toBe("trace-inbound-1");
  });

  it("generates a UUID X-Trace-Id when none is supplied", async () => {
    const res = await handleAuthLogin(loginReq(), { config: TEST_CONFIG });
    expect(res.headers.get("X-Trace-Id")).toMatch(UUID_RE);
  });

  it("sets two HttpOnly OAuth cookies — anthos_oauth_state and anthos_oauth_pkce", async () => {
    const res = await handleAuthLogin(loginReq(), { config: TEST_CONFIG });
    const cookies = res.headers.getSetCookie();
    expect(cookies).toHaveLength(2);
    expect(cookies.some((c) => c.startsWith(`${OAUTH_STATE_COOKIE_NAME}=`))).toBe(true);
    expect(cookies.some((c) => c.startsWith(`${OAUTH_PKCE_COOKIE_NAME}=`))).toBe(true);
    for (const cookie of cookies) {
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("Secure");
      expect(cookie).toContain("SameSite=None");
      expect(cookie).toContain("Path=/api/v1/auth");
      expect(cookie).toContain("Max-Age=300");
    }
  });
});

describe("handleAuthLogin — the cookies prove out the P1B-02 round-trip", () => {
  it("the state cookie decrypts to the state behind the redirect", async () => {
    const res = await handleAuthLogin(loginReq(), { config: TEST_CONFIG });
    const cookies = res.headers.getSetCookie();
    const q = new URL(res.headers.get("Location") ?? "").searchParams;

    const payload = decodeStatePayload(
      aeadDecrypt(cookieValue(cookies, OAUTH_STATE_COOKIE_NAME), COOKIE_KEY),
    );
    expect(payload.state).toBe(q.get("state"));
  });

  it("the pkce cookie's verifier derives the code_challenge in the redirect", async () => {
    const res = await handleAuthLogin(loginReq(), { config: TEST_CONFIG });
    const cookies = res.headers.getSetCookie();
    const q = new URL(res.headers.get("Location") ?? "").searchParams;

    const payload = decodePkcePayload(
      aeadDecrypt(cookieValue(cookies, OAUTH_PKCE_COOKIE_NAME), COOKIE_KEY),
    );
    expect(deriveCodeChallenge(payload.codeVerifier)).toBe(q.get("code_challenge"));
  });
});

describe("handleAuthLogin — returnTo", () => {
  it("persists a valid returnTo into the encrypted state cookie", async () => {
    const res = await handleAuthLogin(loginReq({ returnTo: "/calibration/abc" }), {
      config: TEST_CONFIG,
    });
    expect(res.status).toBe(302);
    const payload = decodeStatePayload(
      aeadDecrypt(cookieValue(res.headers.getSetCookie(), OAUTH_STATE_COOKIE_NAME), COOKIE_KEY),
    );
    expect(payload.returnTo).toBe("/calibration/abc");
  });

  it("omits returnTo from the state payload when none is supplied", async () => {
    const res = await handleAuthLogin(loginReq(), { config: TEST_CONFIG });
    const payload = decodeStatePayload(
      aeadDecrypt(cookieValue(res.headers.getSetCookie(), OAUTH_STATE_COOKIE_NAME), COOKIE_KEY),
    );
    expect(payload.returnTo).toBeUndefined();
  });

  it("treats a bare ?returnTo= (empty) as absent — a 302, not a 400", async () => {
    const res = await handleAuthLogin(loginReq({ returnTo: "" }), {
      config: TEST_CONFIG,
    });
    expect(res.status).toBe(302);
  });

  const rejected: ReadonlyArray<readonly [string, string]> = [
    ["an absolute URL", "https://evil.test"],
    // Dotless host: the allowlist regex ADMITS this — only the `//` guard
    // catches it, so this case genuinely exercises that guard.
    ["a protocol-relative dotless-host URL", "//evilhost"],
    ["a protocol-relative dotted-host URL", "//evil.test"],
    ["a backslash path", "/foo\\bar"],
    ["a path with a disallowed char", "/x y"],
    ["an over-long path", `/${"a".repeat(600)}`],
  ];
  for (const [label, value] of rejected) {
    it(`rejects ${label} with 400 INVALID_QUERY_PARAM`, async () => {
      const res = await handleAuthLogin(loginReq({ returnTo: value }), {
        config: TEST_CONFIG,
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        code: string;
        details: { param: string };
      };
      expect(body.code).toBe("INVALID_QUERY_PARAM");
      expect(body.details.param).toBe("returnTo");
      expect(res.headers.get("Cache-Control")).toBe("no-store");
    });
  }
});

describe("handleAuthLogin — config failure", () => {
  it("returns 500 AUTH_CONFIG_ERROR when env config is missing, leaking no value", async () => {
    // The un-injected path resolves config from process.env; remove the
    // required vars so loadOAuthLoginConfig() throws.
    const saved = { ...process.env };
    delete process.env.SF_LOGIN_URL;
    delete process.env.SF_CONNECTED_APP_CONSUMER_KEY;
    delete process.env.SF_OAUTH_REDIRECT_URI;
    delete process.env.ANTHOS_OAUTH_COOKIE_SECRET;
    try {
      const res = await handleAuthLogin(loginReq());
      expect(res.status).toBe(500);
      const body = (await res.json()) as { code: string; message: string };
      expect(body.code).toBe("AUTH_CONFIG_ERROR");
      expect(body.message).not.toContain("SF_LOGIN_URL");
    } finally {
      process.env = saved;
    }
  });
});

describe("handleAuthLogin — secrecy", () => {
  it("never logs the state, code_challenge, or raw cookie values", async () => {
    // Spy every sink the structured logger writes to — debug/info → console.log,
    // warn → console.warn, error → console.error (packages/logging/src/logger.ts).
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const res = await handleAuthLogin(loginReq(), { config: TEST_CONFIG });
      const cookies = res.headers.getSetCookie();
      const q = new URL(res.headers.get("Location") ?? "").searchParams;
      const state = q.get("state") ?? "";
      const challenge = q.get("code_challenge") ?? "";
      const logged = [...log.mock.calls, ...warn.mock.calls, ...error.mock.calls]
        .map((call) => String(call[0]))
        .join("\n");

      // The benign breadcrumb fired …
      expect(logged).toContain("oauth_login_initiated");
      // … but no secret material reached the log stream.
      expect(state.length).toBeGreaterThan(0);
      expect(logged).not.toContain(state);
      expect(logged).not.toContain(challenge);
      for (const cookie of cookies) {
        expect(logged).not.toContain(cookie.slice(cookie.indexOf("=") + 1, cookie.indexOf(";")));
      }
    } finally {
      log.mockRestore();
      warn.mockRestore();
      error.mockRestore();
    }
  });
});
