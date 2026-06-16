// Refresh configuration — the env-driven knobs for POST /api/v1/auth/refresh
// (E-03). The endpoint needs the Connected App credentials for the
// refresh-token grant, the AES key that decrypts the stored Salesforce refresh
// token (and encrypts a rotated one), the session timeouts, and the
// `anthos_session` cookie policy. It does NOT need the OAuth pre-session cookie
// key or the permission-set → role map — refresh mints no PKCE cookies and does
// not re-resolve the role (that is `/me`, E-05).
//
// Fail-loud on a missing or malformed value, mirroring `callback-config.ts`:
// operator error must not silently degrade an auth endpoint.

import { decodeCookieKey, loadSessionConfig } from "@anthos/auth";
import type { CookieAttributes, SessionConfig } from "@anthos/auth";

import {
  ENV_SF_CLIENT_SECRET,
  ENV_SF_TOKEN_ENC_KEY,
  resolveSessionCookieAttributes,
} from "./callback-config.js";
import { loadOAuthLoginConfig } from "./config.js";

export interface AuthRefreshConfig {
  readonly loginUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
  // Raw 32-byte AES key — decrypts the stored Salesforce refresh token and
  // re-encrypts a Salesforce-rotated one before it is persisted.
  readonly sfTokenEncKey: Buffer;
  // Idle / absolute timeouts (GAP-11, TR-AUTH-7).
  readonly session: SessionConfig;
  // Attributes for the re-issued `anthos_session` Set-Cookie.
  readonly sessionCookie: CookieAttributes;
}

type Env = Record<string, string | undefined>;

// Bracketed read with a constant key — `key` is always a module-level `ENV_*`
// constant, never user input; the object-injection heuristic is a false
// positive, suppressed in one place.
function readEnv(env: Env, key: string): string | undefined {
  // eslint-disable-next-line security/detect-object-injection
  return env[key];
}

// A required var: absent or blank → throw, naming the var (a safe, actionable
// hint — env-var names are not secrets; matches `callback-config.ts`).
function requireValue(env: Env, key: string): string {
  const value = readEnv(env, key);
  if (value === undefined || value.trim().length === 0) {
    throw new Error(
      `${key} is not set; POST /api/v1/auth/refresh cannot exchange the Salesforce refresh token.`,
    );
  }
  return value.trim();
}

// Resolve the effective refresh config from an env map (defaults to
// `process.env`). Throws — naming the offending env var, never its value —
// when a required var is missing or any var is malformed.
export function loadAuthRefreshConfig(env: Env = process.env): AuthRefreshConfig {
  // Reuse the login loader for the shared OAuth fields (loginUrl, clientId) so
  // the auth endpoints cannot drift on the Connected App identity.
  const oauth = loadOAuthLoginConfig(env);
  const clientSecret = requireValue(env, ENV_SF_CLIENT_SECRET);
  const sfTokenEncKey = decodeCookieKey(
    requireValue(env, ENV_SF_TOKEN_ENC_KEY),
    ENV_SF_TOKEN_ENC_KEY,
  );
  const session = loadSessionConfig(env);

  return {
    loginUrl: oauth.loginUrl,
    clientId: oauth.clientId,
    clientSecret,
    sfTokenEncKey,
    session,
    sessionCookie: resolveSessionCookieAttributes(session, env),
  };
}
