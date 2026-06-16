import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import { loadOAuthLoginConfig } from "../../src/auth/config.js";

// A fresh random base64 secret per run — never a hardcoded key in source.
const SECRET = randomBytes(32).toString("base64");

type Env = Record<string, string | undefined>;

function fullEnv(overrides: Env = {}): Env {
  return {
    SF_LOGIN_URL: "https://example.my.salesforce.com",
    SF_CONNECTED_APP_CONSUMER_KEY: "client-abc",
    SF_OAUTH_REDIRECT_URI: "https://bff.test/api/v1/auth/callback",
    ANTHOS_OAUTH_COOKIE_SECRET: SECRET,
    ...overrides,
  };
}

describe("loadOAuthLoginConfig — happy path", () => {
  it("resolves a full config; cookieKey is a 32-byte Buffer", () => {
    const config = loadOAuthLoginConfig(fullEnv());
    expect(config.loginUrl).toBe("https://example.my.salesforce.com");
    expect(config.clientId).toBe("client-abc");
    expect(config.redirectUri).toBe("https://bff.test/api/v1/auth/callback");
    expect(Buffer.isBuffer(config.cookieKey)).toBe(true);
    expect(config.cookieKey).toHaveLength(32);
  });

  it("applies defaults — scope, SameSite=None, Secure, 300s — when optional vars are unset", () => {
    const config = loadOAuthLoginConfig(fullEnv());
    expect(config.scope).toBe("api refresh_token");
    expect(config.cookieSameSite).toBe("None");
    expect(config.cookieSecure).toBe(true);
    expect(config.cookieMaxAgeSeconds).toBe(300);
  });

  it("honors optional overrides", () => {
    const config = loadOAuthLoginConfig(
      fullEnv({
        SF_OAUTH_SCOPE: "api refresh_token id",
        ANTHOS_OAUTH_COOKIE_SAMESITE: "Lax",
        ANTHOS_OAUTH_COOKIE_SECURE: "false",
      }),
    );
    expect(config.scope).toBe("api refresh_token id");
    expect(config.cookieSameSite).toBe("Lax");
    expect(config.cookieSecure).toBe(false);
  });
});

describe("loadOAuthLoginConfig — fails loud on bad config", () => {
  it("throws (naming SF_LOGIN_URL) when it is missing", () => {
    expect(() =>
      loadOAuthLoginConfig({
        SF_CONNECTED_APP_CONSUMER_KEY: "client-abc",
        SF_OAUTH_REDIRECT_URI: "https://bff.test/api/v1/auth/callback",
        ANTHOS_OAUTH_COOKIE_SECRET: SECRET,
      }),
    ).toThrow(/SF_LOGIN_URL/);
  });

  it("throws (naming SF_CONNECTED_APP_CONSUMER_KEY) when it is missing", () => {
    expect(() =>
      loadOAuthLoginConfig({
        SF_LOGIN_URL: "https://example.my.salesforce.com",
        SF_OAUTH_REDIRECT_URI: "https://bff.test/api/v1/auth/callback",
        ANTHOS_OAUTH_COOKIE_SECRET: SECRET,
      }),
    ).toThrow(/SF_CONNECTED_APP_CONSUMER_KEY/);
  });

  it("throws (naming SF_OAUTH_REDIRECT_URI) when it is missing", () => {
    expect(() =>
      loadOAuthLoginConfig({
        SF_LOGIN_URL: "https://example.my.salesforce.com",
        SF_CONNECTED_APP_CONSUMER_KEY: "client-abc",
        ANTHOS_OAUTH_COOKIE_SECRET: SECRET,
      }),
    ).toThrow(/SF_OAUTH_REDIRECT_URI/);
  });

  it("throws (naming ANTHOS_OAUTH_COOKIE_SECRET) when it is missing", () => {
    expect(() =>
      loadOAuthLoginConfig({
        SF_LOGIN_URL: "https://example.my.salesforce.com",
        SF_CONNECTED_APP_CONSUMER_KEY: "client-abc",
        SF_OAUTH_REDIRECT_URI: "https://bff.test/api/v1/auth/callback",
      }),
    ).toThrow(/ANTHOS_OAUTH_COOKIE_SECRET/);
  });

  it("throws on a wrong-length cookie secret — never echoing the value", () => {
    const badSecret = randomBytes(16).toString("base64");
    try {
      loadOAuthLoginConfig(fullEnv({ ANTHOS_OAUTH_COOKIE_SECRET: badSecret }));
      expect.unreachable("loadOAuthLoginConfig should have thrown");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toContain("ANTHOS_OAUTH_COOKIE_SECRET");
      expect(message).not.toContain(badSecret);
    }
  });

  it("throws on an invalid SameSite value", () => {
    expect(() => loadOAuthLoginConfig(fullEnv({ ANTHOS_OAUTH_COOKIE_SAMESITE: "Banana" }))).toThrow(
      /ANTHOS_OAUTH_COOKIE_SAMESITE/,
    );
  });
});
