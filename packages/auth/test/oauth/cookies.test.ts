import { describe, expect, it } from "vitest";

import {
  clearOAuthPkceCookie,
  clearOAuthStateCookie,
  decodePkcePayload,
  decodeStatePayload,
  encodePkcePayload,
  encodeStatePayload,
  OAUTH_PKCE_COOKIE_NAME,
  OAUTH_STATE_COOKIE_NAME,
  readOAuthCookie,
  serializeOAuthPkceCookie,
  serializeOAuthStateCookie,
} from "../../src/oauth/cookies.js";
import type { OAuthCookieAttributes } from "../../src/oauth/cookies.js";

// Deployed-environment cookie policy (API §7.2.1).
const DEPLOYED: OAuthCookieAttributes = {
  secure: true,
  sameSite: "None",
  path: "/api/v1/auth",
  maxAgeSeconds: 300,
};

describe("OAuth cookies — serialize (API §7.2.1)", () => {
  it("anthos_oauth_state carries HttpOnly, Secure, SameSite=None, Path, Max-Age", () => {
    const cookie = serializeOAuthStateCookie("CIPHERTEXT", DEPLOYED);
    expect(cookie.startsWith(`${OAUTH_STATE_COOKIE_NAME}=CIPHERTEXT`)).toBe(true);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=None");
    expect(cookie).toContain("Path=/api/v1/auth");
    expect(cookie).toContain("Max-Age=300");
  });

  it("anthos_oauth_pkce carries the same attribute set", () => {
    const cookie = serializeOAuthPkceCookie("CIPHERTEXT", DEPLOYED);
    expect(cookie.startsWith(`${OAUTH_PKCE_COOKIE_NAME}=CIPHERTEXT`)).toBe(true);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=None");
  });

  it("omits Secure when secure:false (local-dev http knob)", () => {
    const cookie = serializeOAuthStateCookie("X", {
      ...DEPLOYED,
      secure: false,
      sameSite: "Lax",
    });
    expect(cookie).not.toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
  });

  it("clear* expire the cookie immediately (Max-Age=0, empty value)", () => {
    const stateCleared = clearOAuthStateCookie(DEPLOYED);
    expect(stateCleared).toContain(`${OAUTH_STATE_COOKIE_NAME}=;`);
    expect(stateCleared).toContain("Max-Age=0");
    expect(clearOAuthPkceCookie(DEPLOYED)).toContain("Max-Age=0");
  });
});

describe("OAuth cookies — payload encode/decode", () => {
  it("state payload round-trips with returnTo", () => {
    const payload = { state: "s-123", returnTo: "/calibration/abc" };
    expect(decodeStatePayload(encodeStatePayload(payload))).toEqual(payload);
  });

  it("state payload round-trips without returnTo — the key stays absent", () => {
    const decoded = decodeStatePayload(encodeStatePayload({ state: "s-123" }));
    expect(decoded).toEqual({ state: "s-123" });
    expect(decoded).not.toHaveProperty("returnTo");
  });

  it("pkce payload round-trips", () => {
    const payload = { codeVerifier: "v".repeat(43) };
    expect(decodePkcePayload(encodePkcePayload(payload))).toEqual(payload);
  });

  it("decodeStatePayload throws on a missing state", () => {
    expect(() => decodeStatePayload(JSON.stringify({ returnTo: "/x" }))).toThrow();
  });

  it("decodePkcePayload throws on a missing codeVerifier", () => {
    expect(() => decodePkcePayload(JSON.stringify({}))).toThrow();
  });
});

describe("OAuth cookies — readOAuthCookie", () => {
  it("extracts the named cookie from among several", () => {
    const header = `anthos_session=abc; ${OAUTH_STATE_COOKIE_NAME}=STATEVAL; ${OAUTH_PKCE_COOKIE_NAME}=PKCEVAL`;
    expect(readOAuthCookie(header, OAUTH_STATE_COOKIE_NAME)).toBe("STATEVAL");
    expect(readOAuthCookie(header, OAUTH_PKCE_COOKIE_NAME)).toBe("PKCEVAL");
  });

  it("returns null when the named cookie is absent", () => {
    expect(readOAuthCookie("anthos_session=abc", OAUTH_STATE_COOKIE_NAME)).toBeNull();
  });

  it("returns null for an absent header", () => {
    expect(readOAuthCookie(null, OAUTH_STATE_COOKIE_NAME)).toBeNull();
    expect(readOAuthCookie(undefined, OAUTH_STATE_COOKIE_NAME)).toBeNull();
  });
});
