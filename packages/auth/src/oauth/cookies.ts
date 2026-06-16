// Set-Cookie serialization + Cookie parsing for the two encrypted OAuth
// pre-session cookies. API §7.2.1: GET /api/v1/auth/login sets
// `anthos_oauth_state` and `anthos_oauth_pkce`, both HttpOnly + Secure +
// SameSite=None, short-lived. The cookie VALUES are AEAD ciphertext (see
// `crypto.ts`) — this module is a pure string builder and never sees the key.
//
// Pure, I/O-free, dependency-free. Mirrors `session/cookie.ts`.
import type { SameSite } from "../session/cookie.js";

export const OAUTH_STATE_COOKIE_NAME = "anthos_oauth_state";
export const OAUTH_PKCE_COOKIE_NAME = "anthos_oauth_pkce";

// Cookie policy for the OAuth pre-session cookies. `HttpOnly` is
// non-negotiable — the encrypted verifier must never be readable by
// JavaScript — so it is not a field. `path` scopes the cookies to the auth
// flow so they are not sent on every request; the callback's clear-cookie
// MUST reuse the same path.
export interface OAuthCookieAttributes {
  readonly secure: boolean;
  readonly sameSite: SameSite;
  readonly path: string;
  readonly maxAgeSeconds: number;
}

// Decrypted payload of `anthos_oauth_state`: the CSRF `state` plus the optional
// validated post-auth redirect path. `returnTo` rides inside the (encrypted)
// state cookie rather than a third cookie — API §7.2.1 names only two.
export interface OAuthStatePayload {
  readonly state: string;
  readonly returnTo?: string;
}

// Decrypted payload of `anthos_oauth_pkce`.
export interface OAuthPkcePayload {
  readonly codeVerifier: string;
}

function baseAttributes(attrs: OAuthCookieAttributes): string[] {
  const parts = [`Path=${attrs.path}`, `SameSite=${attrs.sameSite}`, "HttpOnly"];
  if (attrs.secure) {
    parts.push("Secure");
  }
  return parts;
}

function serialize(name: string, value: string, attrs: OAuthCookieAttributes): string {
  return [
    `${name}=${value}`,
    ...baseAttributes(attrs),
    `Max-Age=${Math.max(0, Math.floor(attrs.maxAgeSeconds))}`,
  ].join("; ");
}

function clear(name: string, attrs: OAuthCookieAttributes): string {
  return [`${name}=`, ...baseAttributes(attrs), "Max-Age=0"].join("; ");
}

// Build the `Set-Cookie` value for `anthos_oauth_state`. `encryptedValue` is
// the AEAD ciphertext from `aeadEncrypt` (already base64url, cookie-safe).
export function serializeOAuthStateCookie(
  encryptedValue: string,
  attrs: OAuthCookieAttributes,
): string {
  return serialize(OAUTH_STATE_COOKIE_NAME, encryptedValue, attrs);
}

// Build the `Set-Cookie` value for `anthos_oauth_pkce`.
export function serializeOAuthPkceCookie(
  encryptedValue: string,
  attrs: OAuthCookieAttributes,
): string {
  return serialize(OAUTH_PKCE_COOKIE_NAME, encryptedValue, attrs);
}

// Clear `anthos_oauth_state` (`Max-Age=0`). Used by P1B-02 once the callback
// consumes it; ships now so the cookie module is complete and symmetric.
export function clearOAuthStateCookie(attrs: OAuthCookieAttributes): string {
  return clear(OAUTH_STATE_COOKIE_NAME, attrs);
}

// Clear `anthos_oauth_pkce` (`Max-Age=0`).
export function clearOAuthPkceCookie(attrs: OAuthCookieAttributes): string {
  return clear(OAUTH_PKCE_COOKIE_NAME, attrs);
}

// Read a named cookie's raw (still-encrypted) value from an inbound `Cookie`
// header. Returns null when the header is absent or carries no such cookie.
// For P1B-02's use; mirrors `parseSessionCookie`.
export function readOAuthCookie(
  cookieHeader: string | null | undefined,
  name: string,
): string | null {
  if (cookieHeader === null || cookieHeader === undefined || cookieHeader.length === 0) {
    return null;
  }
  for (const pair of cookieHeader.split(";")) {
    const eq = pair.indexOf("=");
    if (eq === -1) {
      continue;
    }
    if (pair.slice(0, eq).trim() === name) {
      const value = pair.slice(eq + 1).trim();
      return value.length > 0 ? value : null;
    }
  }
  return null;
}

// JSON serialization of the state payload — separated from encryption so each
// layer is independently testable.
export function encodeStatePayload(payload: OAuthStatePayload): string {
  return JSON.stringify(payload);
}

// Parse + shape-validate a decrypted state payload. Throws on a shape mismatch
// (a tampered-but-validly-decrypted blob, or a future format change).
export function decodeStatePayload(json: string): OAuthStatePayload {
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("decodeStatePayload: payload is not an object.");
  }
  const record = parsed as Record<string, unknown>;
  const state = record["state"];
  const returnTo = record["returnTo"];
  if (typeof state !== "string" || state.length === 0) {
    throw new Error("decodeStatePayload: missing `state`.");
  }
  if (returnTo !== undefined && typeof returnTo !== "string") {
    throw new Error("decodeStatePayload: `returnTo` must be a string when present.");
  }
  return returnTo === undefined ? { state } : { state, returnTo };
}

// JSON serialization of the PKCE payload.
export function encodePkcePayload(payload: OAuthPkcePayload): string {
  return JSON.stringify(payload);
}

// Parse + shape-validate a decrypted PKCE payload. Throws on a shape mismatch.
export function decodePkcePayload(json: string): OAuthPkcePayload {
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("decodePkcePayload: payload is not an object.");
  }
  const codeVerifier = (parsed as Record<string, unknown>)["codeVerifier"];
  if (typeof codeVerifier !== "string" || codeVerifier.length === 0) {
    throw new Error("decodePkcePayload: missing `codeVerifier`.");
  }
  return { codeVerifier };
}
