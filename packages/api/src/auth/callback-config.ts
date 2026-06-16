// Callback configuration — the env-driven knobs for GET /api/v1/auth/callback
// (E-02). Composes `loadOAuthLoginConfig` (the shared OAuth fields) with the
// callback-only secrets: the Connected App client secret (the code exchange
// needs it; the login redirect does not), the AES key that encrypts the
// Salesforce refresh token at rest, and the permission-set → role map.
//
// Fail-loud on a missing or malformed value, mirroring `config.ts`: operator
// error must not silently degrade an auth endpoint.
import { decodeCookieKey, isRole, loadSessionConfig } from "@anthos/auth";
import type {
  CookieAttributes,
  Role,
  SameSite,
  SessionConfig,
} from "@anthos/auth";

import { loadOAuthLoginConfig } from "./config.js";

// The Connected App consumer secret — sent in the `authorization_code` token
// exchange body (RFC 6749 §4.1.3). Same env var `SalesforceConnectedAppAuth`
// reads; the login redirect never needs it.
export const ENV_SF_CLIENT_SECRET = "SF_CONNECTED_APP_CONSUMER_SECRET";

// Base64 32-byte AES-256 key encrypting the Salesforce refresh token at rest in
// `sessions.sf_refresh_token_encrypted`. Deliberately SEPARATE from the OAuth
// cookie key (`ANTHOS_OAUTH_COOKIE_SECRET`): the cookie key guards a 5-minute
// pre-session blob, this one guards a long-lived credential — key separation
// limits blast radius if either leaks.
export const ENV_SF_TOKEN_ENC_KEY = "ANTHOS_SF_TOKEN_ENC_KEY";

// A JSON object whose keys are Salesforce PermissionSet API names and whose
// values are tool roles. The role values are the UPPERCASE internal `Role`
// enum (`SPECIALIST` | `SUPERVISOR` | `VP` | `SYSTEM_ADMIN`) — matching
// `@anthos/auth` `ROLES` and the `sessions.role` CHECK constraint, NOT the
// lowercase API §8.3.1 wire enum (`specialist` | …); `/me` (P1B-05) converts
// to the wire casing on output. The four perm-set API names are an
// Anthos-SF-admin artifact (owned by Erik) — discover them from the
// `anthos-demo` sandbox and set this var per environment. PERMSET NAMES
// UNCONFIRMED at time of writing: as of P1B-02 the four tool role permission
// sets do not yet exist in the sandbox; the keys must be confirmed once Erik
// provisions them.
export const ENV_ROLE_PERMISSION_SETS = "ANTHOS_ROLE_PERMISSION_SETS";

export interface AuthCallbackConfig {
  readonly loginUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  // Space-delimited scopes requested at /authorize — BR-01 verifies the grant.
  readonly scope: string;
  // Raw 32-byte AES key — decrypts the inbound `anthos_oauth_state` / `_pkce`
  // cookies P1B-01 wrote.
  readonly oauthCookieKey: Buffer;
  // OAuth pre-session cookie policy — reused when clearing the two cookies on a
  // successful exchange, so the `Set-Cookie` attributes byte-match P1B-01's.
  readonly oauthCookieSecure: boolean;
  readonly oauthCookieSameSite: SameSite;
  // Raw 32-byte AES key — encrypts the Salesforce refresh token at rest.
  readonly sfTokenEncKey: Buffer;
  // Salesforce PermissionSet API name → tool role (TR-AUTH-8).
  readonly rolePermissionSets: Readonly<Record<string, Role>>;
  // Idle / absolute timeouts (GAP-11, TR-AUTH-7) — `startSession` reads
  // `absoluteTimeoutSeconds`; the session-cookie Max-Age tracks the idle one.
  readonly session: SessionConfig;
  // Attributes for the `anthos_session` Set-Cookie. The tool is embedded in a
  // cross-origin Salesforce iframe, so the deployed cookie MUST be
  // `SameSite=None; Secure` (API §7.2.2, SEC-AUTH-4 iframe note) — see
  // `loadAuthCallbackConfig`.
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
// hint — env-var names are not secrets; matches `config.ts`).
function requireValue(env: Env, key: string): string {
  const value = readEnv(env, key);
  if (value === undefined || value.trim().length === 0) {
    throw new Error(
      `${key} is not set; GET /api/v1/auth/callback cannot complete the OAuth exchange.`,
    );
  }
  return value.trim();
}

// Parse + validate the permission-set → role map. Every value must be a known
// `Role`; an empty map is operator error (no specialist could ever resolve).
function parseRolePermissionSets(raw: string): Readonly<Record<string, Role>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${ENV_ROLE_PERMISSION_SETS} must be a valid JSON object.`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `${ENV_ROLE_PERMISSION_SETS} must be a JSON object of permissionSetName → role.`,
    );
  }
  const entries: Array<[string, Role]> = [];
  for (const [permissionSet, role] of Object.entries(parsed)) {
    if (!isRole(role)) {
      // The role VALUE is config, not a secret — naming the bad mapping is a
      // safe, actionable hint.
      throw new Error(
        `${ENV_ROLE_PERMISSION_SETS}: permission set "${permissionSet}" maps to ` +
          `an unknown role (expected SPECIALIST | SUPERVISOR | VP | SYSTEM_ADMIN).`,
      );
    }
    entries.push([permissionSet, role]);
  }
  if (entries.length === 0) {
    throw new Error(
      `${ENV_ROLE_PERMISSION_SETS} must map at least one permission set to a role.`,
    );
  }
  return Object.fromEntries(entries);
}

// The `anthos_session` Set-Cookie attributes, shared by the callback (E-02)
// and refresh (E-03) config loaders so the two cannot drift. The tool runs
// inside a cross-origin Salesforce iframe — the deployed cookie MUST be
// `SameSite=None; Secure` (API §7.2.2, SEC-AUTH-4). Local non-production dev
// runs outside the iframe, often over plain http where a `Secure` cookie will
// not set — there the env-driven `loadSessionConfig` cookie policy (the `Lax`
// default, or whatever `ANTHOS_SESSION_COOKIE_SAMESITE` says) is honored
// instead. Keyed on `NODE_ENV` per the P1B-02 ticket note.
export function resolveSessionCookieAttributes(
  session: SessionConfig,
  env: Env = process.env,
): CookieAttributes {
  const isProduction = readEnv(env, "NODE_ENV") === "production";
  return isProduction
    ? {
        httpOnly: true,
        secure: true,
        sameSite: "None",
        path: "/",
        ...(session.cookie.domain !== undefined
          ? { domain: session.cookie.domain }
          : {}),
      }
    : session.cookie;
}

// Resolve the effective callback config from an env map (defaults to
// `process.env`). Throws — naming the offending env var, never its value —
// when a required var is missing or any var is malformed.
export function loadAuthCallbackConfig(env: Env = process.env): AuthCallbackConfig {
  // Reuse the login loader for the shared OAuth fields (loginUrl, clientId,
  // redirectUri, scope, cookie key + policy) so the two endpoints cannot drift.
  const oauth = loadOAuthLoginConfig(env);
  const clientSecret = requireValue(env, ENV_SF_CLIENT_SECRET);
  const sfTokenEncKey = decodeCookieKey(
    requireValue(env, ENV_SF_TOKEN_ENC_KEY),
    ENV_SF_TOKEN_ENC_KEY,
  );
  const rolePermissionSets = parseRolePermissionSets(
    requireValue(env, ENV_ROLE_PERMISSION_SETS),
  );

  const session = loadSessionConfig(env);
  const sessionCookie = resolveSessionCookieAttributes(session, env);

  return {
    loginUrl: oauth.loginUrl,
    clientId: oauth.clientId,
    clientSecret,
    redirectUri: oauth.redirectUri,
    scope: oauth.scope,
    oauthCookieKey: oauth.cookieKey,
    oauthCookieSecure: oauth.cookieSecure,
    oauthCookieSameSite: oauth.cookieSameSite,
    sfTokenEncKey,
    rolePermissionSets,
    session,
    sessionCookie,
  };
}
