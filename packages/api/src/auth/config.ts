// OAuth-login configuration — the env-driven knobs for GET /api/v1/auth/login
// (E-01). Mirrors `auth/src/session/config.ts`: `ENV_*` constants, `parse*`
// helpers, fail-loud on a missing or malformed value. Operator error must not
// silently degrade an auth endpoint — a bad config throws, it never defaults.
import { decodeCookieKey } from "@anthos/auth";
import type { SameSite } from "@anthos/auth";

export const ENV_SF_LOGIN_URL = "SF_LOGIN_URL";
export const ENV_SF_CLIENT_ID = "SF_CONNECTED_APP_CONSUMER_KEY";
export const ENV_OAUTH_REDIRECT_URI = "SF_OAUTH_REDIRECT_URI";
export const ENV_OAUTH_COOKIE_SECRET = "ANTHOS_OAUTH_COOKIE_SECRET";
export const ENV_OAUTH_SCOPE = "SF_OAUTH_SCOPE";
export const ENV_OAUTH_COOKIE_SECURE = "ANTHOS_OAUTH_COOKIE_SECURE";
export const ENV_OAUTH_COOKIE_SAMESITE = "ANTHOS_OAUTH_COOKIE_SAMESITE";

// Salesforce OAuth scope tokens for the authorize URL — NOT the Connected App
// object permissions. TR-AUTH-2 / BR-01 enumerate object-level least privilege
// (Participant, Case Note, Contact, …); that is the PF-09 Connected App's
// assigned permission set, configured in Salesforce, not a `scope` query-param
// value. `api` grants REST/SOQL access; `refresh_token` lets the callback
// (P1B-02) obtain a refresh token to hold server-side (SAD §9.2). Overridable
// via `SF_OAUTH_SCOPE`.
export const DEFAULT_OAUTH_SCOPE = "api refresh_token";

// Pre-session cookie lifetime — long enough to complete the Salesforce login,
// short enough to bound a stale PKCE pair (~5 min).
export const DEFAULT_OAUTH_COOKIE_MAX_AGE_SECONDS = 300;

// SameSite=None — the callback arrives as a cross-site top-level navigation
// from Salesforce, and the tool runs inside the Salesforce iframe (API §7.2.1).
// Local dev over http can override to `Lax` (browsers reject None without
// Secure); deployed envs MUST be None + Secure.
export const DEFAULT_OAUTH_COOKIE_SAMESITE: SameSite = "None";

export interface OAuthLoginConfig {
  readonly loginUrl: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly scope: string;
  // Raw 32-byte AES-256 key for the encrypted OAuth cookies.
  readonly cookieKey: Buffer;
  readonly cookieSecure: boolean;
  readonly cookieSameSite: SameSite;
  readonly cookieMaxAgeSeconds: number;
}

type Env = Record<string, string | undefined>;

// Bracketed read with a constant key. `env` is a plain string map and every
// key passed here is a module-level `ENV_*` constant — never user input — so
// the object-injection heuristic is a false positive, suppressed in one place.
function readEnv(env: Env, key: string): string | undefined {
  // eslint-disable-next-line security/detect-object-injection
  return env[key];
}

// A required var: absent or blank → throw, naming the var (a safe, actionable
// hint — env-var names are not secrets; matches `connected-app-auth.ts`).
function requireValue(env: Env, key: string): string {
  const value = readEnv(env, key);
  if (value === undefined || value.trim().length === 0) {
    throw new Error(
      `${key} is not set; GET /api/v1/auth/login cannot build the Salesforce authorize URL.`,
    );
  }
  return value.trim();
}

function parseSameSite(raw: string | undefined): SameSite {
  if (raw === undefined || raw.trim().length === 0) {
    return DEFAULT_OAUTH_COOKIE_SAMESITE;
  }
  const value = raw.trim();
  if (value === "Lax" || value === "Strict" || value === "None") {
    return value;
  }
  throw new Error(`${ENV_OAUTH_COOKIE_SAMESITE} must be Lax | Strict | None; got "${raw}".`);
}

function parseBool(raw: string | undefined, key: string, fallback: boolean): boolean {
  if (raw === undefined || raw.trim().length === 0) {
    return fallback;
  }
  const value = raw.trim().toLowerCase();
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new Error(`${key} must be true | false; got "${raw}".`);
}

// Resolve the effective OAuth-login config from an env map (defaults to
// `process.env`). Throws — naming the offending env var, never its value —
// when a required var is missing or any var is malformed.
export function loadOAuthLoginConfig(env: Env = process.env): OAuthLoginConfig {
  const loginUrl = requireValue(env, ENV_SF_LOGIN_URL);
  const clientId = requireValue(env, ENV_SF_CLIENT_ID);
  const redirectUri = requireValue(env, ENV_OAUTH_REDIRECT_URI);
  const cookieKey = decodeCookieKey(
    requireValue(env, ENV_OAUTH_COOKIE_SECRET),
    ENV_OAUTH_COOKIE_SECRET,
  );

  const scopeRaw = readEnv(env, ENV_OAUTH_SCOPE);
  const scope =
    scopeRaw !== undefined && scopeRaw.trim().length > 0 ? scopeRaw.trim() : DEFAULT_OAUTH_SCOPE;

  return {
    loginUrl,
    clientId,
    redirectUri,
    scope,
    cookieKey,
    cookieSecure: parseBool(readEnv(env, ENV_OAUTH_COOKIE_SECURE), ENV_OAUTH_COOKIE_SECURE, true),
    cookieSameSite: parseSameSite(readEnv(env, ENV_OAUTH_COOKIE_SAMESITE)),
    cookieMaxAgeSeconds: DEFAULT_OAUTH_COOKIE_MAX_AGE_SECONDS,
  };
}
