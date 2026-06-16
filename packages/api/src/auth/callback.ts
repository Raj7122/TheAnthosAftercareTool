// GET /api/v1/auth/callback (endpoint E-02) — the Salesforce OAuth redirect
// target that completes the Authorization Code + PKCE flow P1B-01 began (F-01,
// TR-AUTH-1/3/8/9, SEC-AUTH-1/2, ARC-12/13). The handler:
//   1. validates `state` against the encrypted `anthos_oauth_state` cookie
//      (constant-time);
//   2. exchanges `code` for tokens with the stored PKCE `code_verifier`;
//   3. resolves the specialist's role from their Salesforce permission set
//      (TR-AUTH-8);
//   4. creates the opaque DB-backed session via P1A-04's `startSession`, which
//      persists the AES-256-GCM-encrypted refresh token and writes the
//      `auth.session_start` audit row BEFORE this handler builds its 302
//      (Immutable #5);
//   5. sets the first-party `anthos_session` cookie and clears the two OAuth
//      pre-session cookies;
//   6. 302-redirects to the post-login landing page (`/` or `returnTo`).
//
// All business logic lives here so it is unit-testable without a Next runtime;
// `apps/web` carries only a thin route shim. /auth/callback is a PUBLIC
// endpoint — there is no session yet — so it is NOT wrapped by `withSession`.
//
// Secrets posture: the `code`, `code_verifier`, access token, and refresh token
// never reach a log line, a URL, an error body, or `payload_metadata`. Failures
// before the Salesforce user id is known are structured-logged only (the audit
// writer requires a `specialistId`, and a rejected request is not a state
// mutation — the E-01 precedent); `auth.failure` audit rows are written once
// the id IS known. Every audit row precedes the response it accompanies.

import { timingSafeEqual } from "node:crypto";

import { writeAuditEntry } from "@anthos/audit";
import {
  aeadDecrypt,
  aeadEncrypt,
  clearOAuthPkceCookie,
  clearOAuthStateCookie,
  decodePkcePayload,
  decodeStatePayload,
  hashUserAgent,
  OAUTH_PKCE_COOKIE_NAME,
  OAUTH_STATE_COOKIE_NAME,
  readOAuthCookie,
  ROLES,
  serializeSessionCookie,
} from "@anthos/auth";
import type { OAuthCookieAttributes, Role } from "@anthos/auth";
import {
  exchangeAuthorizationCode,
  fetchSalesforceUserIdentity,
  parseSalesforceUserId,
  resolveRoleFromPermissionSet,
  RoleResolutionError,
  SalesforceError,
  SalesforceRestClient,
} from "@anthos/integrations";
import type {
  AuthorizationCodeExchangeInput,
  SalesforceAuth,
  TokenExchangeResult,
} from "@anthos/integrations";
import { createLogger, resolveTraceId } from "@anthos/logging";
import type { StructuredLogger } from "@anthos/logging";
import type { DbOrTx } from "@anthos/persistence";

import { startSession } from "../session/service.js";
import type { SessionStore } from "../session/store.js";
import { loadAuthCallbackConfig } from "./callback-config.js";
import type { AuthCallbackConfig } from "./callback-config.js";
import { OAUTH_COOKIE_PATH } from "./login.js";
import { authErrorResponse, authRedirectFailure } from "./responses.js";
import { validateReturnTo } from "./return-to.js";

// Where a successful callback lands when login carried no `returnTo`.
const DEFAULT_LANDING = "/";

// Structured logger for this endpoint; a per-request child binds trace_id.
const defaultLogger = createLogger({ module: "api.auth" });

// Exchange `code` → tokens. The default wraps `exchangeAuthorizationCode`;
// tests inject a stub.
export type CodeExchanger = (
  input: AuthorizationCodeExchangeInput,
) => Promise<TokenExchangeResult>;

// What the resolver yields — the tool role plus the specialist's own identity,
// both resolved from Salesforce at session start (TR-AUTH-8). The identity
// fields ride onto the session row so `GET /me` (E-05) is a pure DB read.
export interface ResolvedSpecialist {
  readonly role: Role;
  readonly displayName: string;
  readonly email: string;
  readonly timezone: string;
}

// Resolve the tool role + identity for an authenticated Salesforce user. The
// default queries `PermissionSetAssignment` and the `User` record; tests
// inject a stub.
export type SpecialistResolver = (input: {
  readonly accessToken: string;
  readonly instanceUrl: string;
  readonly userId: string;
}) => Promise<ResolvedSpecialist>;

export interface AuthCallbackOptions {
  // Injected for tests — defaults to `loadAuthCallbackConfig()` (memoized).
  readonly config?: AuthCallbackConfig;
  // Injected for tests — defaults to the lazily-resolved Postgres store.
  readonly store?: SessionStore;
  // Injected for tests — defaults to the lazily-resolved default DB handle.
  readonly db?: DbOrTx;
  // Injected for tests — defaults to the `api.auth` logger.
  readonly logger?: StructuredLogger;
  // Injected for the route integration test — threaded into the SF token
  // exchange and the permission-set REST client. Defaults to global `fetch`.
  readonly fetchImpl?: typeof fetch;
  // Unit-test seams — stub the Salesforce round-trips outright.
  readonly exchangeCode?: CodeExchanger;
  readonly resolveSpecialist?: SpecialistResolver;
}

// Memoized default config — `loadAuthCallbackConfig` reads `process.env`, fixed
// at boot. A throw is NOT memoized, so a misconfigured deploy keeps failing
// loudly per request.
let defaultConfig: AuthCallbackConfig | undefined;

function resolveConfig(injected: AuthCallbackConfig | undefined): AuthCallbackConfig {
  if (injected !== undefined) {
    return injected;
  }
  defaultConfig ??= loadAuthCallbackConfig();
  return defaultConfig;
}

// Lazily-resolved, memoized default store + DB handle. The dynamic imports keep
// the @anthos/persistence connection side effect out of @anthos/api's static
// import graph (mirrors the session middleware). Tests inject `options.store`
// / `options.db` so this DB-backed path is never reached.
let defaultStorePromise: Promise<SessionStore> | undefined;

async function resolveStore(injected: SessionStore | undefined): Promise<SessionStore> {
  if (injected !== undefined) {
    return injected;
  }
  defaultStorePromise ??= import("../session/postgres-store.js").then((m) =>
    m.createDefaultPostgresStore(),
  );
  return defaultStorePromise;
}

let defaultDbPromise: Promise<DbOrTx> | undefined;

async function resolveDb(injected: DbOrTx | undefined): Promise<DbOrTx> {
  if (injected !== undefined) {
    return injected;
  }
  defaultDbPromise ??= import("@anthos/persistence").then((m) => m.db);
  return defaultDbPromise;
}

// The full E-02 handler. Resolves trace_id + config, validates `state`,
// exchanges `code`, resolves role, starts the session, and returns 302 with
// `Location`, the `anthos_session` `Set-Cookie`, two cleared OAuth cookies,
// `Cache-Control: no-store`, and `X-Trace-Id`.
export async function handleAuthCallback(
  req: Request,
  options: AuthCallbackOptions = {},
): Promise<Response> {
  const traceId = resolveTraceId(req);
  const log = (options.logger ?? defaultLogger).child({ traceId });

  // Config: a missing / malformed env var is operator error → 500. The thrown
  // message names the env var (safe) and is logged only, never echoed.
  let config: AuthCallbackConfig;
  try {
    config = resolveConfig(options.config);
  } catch (err) {
    log.error("oauth callback configuration error", {
      event: "oauth_callback_config_error",
      reason: errorReason(err),
    });
    return authErrorResponse("AUTH_CONFIG_ERROR", traceId);
  }

  try {
    return await runCallback(req, options, config, log, traceId);
  } catch (err) {
    // Safety net for an unexpected throw — no silent catch. A real
    // failure mode has its own branch above; reaching here is a bug.
    log.error("oauth callback failed unexpectedly", {
      event: "oauth_callback_internal_error",
      reason: errorReason(err),
    });
    return authRedirectFailure("oauth_failed", traceId);
  }
}

async function runCallback(
  req: Request,
  options: AuthCallbackOptions,
  config: AuthCallbackConfig,
  log: StructuredLogger,
  traceId: string,
): Promise<Response> {
  const params = new URL(req.url).searchParams;

  // Step 1 — query params. A Salesforce-reported `?error=` (user cancelled at
  // the IdP, or an upstream failure) → the FS-01 user-friendly OAuth-failure
  // path. A callback with no `code`/`state` is a malformed direct hit, never a
  // real Salesforce redirect → a JSON 400, not a redirect.
  const oauthError = params.get("error");
  if (oauthError !== null && oauthError.length > 0) {
    log.warn("oauth callback received an upstream error", {
      event: "oauth_callback_upstream_error",
    });
    return authRedirectFailure("oauth_denied", traceId);
  }
  const code = params.get("code");
  const state = params.get("state");
  if (code === null || code.length === 0) {
    log.warn("oauth callback missing the code query param", {
      event: "oauth_callback_invalid_request",
    });
    return authErrorResponse("INVALID_QUERY_PARAM", traceId, { param: "code" });
  }
  if (state === null || state.length === 0) {
    log.warn("oauth callback missing the state query param", {
      event: "oauth_callback_invalid_request",
    });
    return authErrorResponse("INVALID_QUERY_PARAM", traceId, { param: "state" });
  }

  // Step 2 — read + decrypt the two OAuth pre-session cookies (P1B-01). A
  // missing cookie, a tampered ciphertext (AEAD fails loudly), or a malformed
  // payload all land on the same user-friendly retry path. The cookie VALUES
  // are never logged.
  const cookieHeader = req.headers.get("cookie");
  const encryptedState = readOAuthCookie(cookieHeader, OAUTH_STATE_COOKIE_NAME);
  const encryptedPkce = readOAuthCookie(cookieHeader, OAUTH_PKCE_COOKIE_NAME);
  if (encryptedState === null || encryptedPkce === null) {
    log.warn("oauth callback is missing a pre-session cookie", {
      event: "oauth_callback_cookie_absent",
    });
    return authRedirectFailure("oauth_failed", traceId);
  }
  let cookieState: string;
  let codeVerifier: string;
  let returnTo: string | undefined;
  try {
    const statePayload = decodeStatePayload(
      aeadDecrypt(encryptedState, config.oauthCookieKey),
    );
    const pkcePayload = decodePkcePayload(
      aeadDecrypt(encryptedPkce, config.oauthCookieKey),
    );
    cookieState = statePayload.state;
    returnTo = statePayload.returnTo;
    codeVerifier = pkcePayload.codeVerifier;
  } catch {
    log.warn("oauth callback could not decrypt a pre-session cookie", {
      event: "oauth_callback_cookie_invalid",
    });
    return authRedirectFailure("oauth_failed", traceId);
  }

  // Step 3 — constant-time `state` comparison (API §8 — defends against a
  // forged or replayed callback).
  if (!timingSafeEqualStrings(state, cookieState)) {
    log.warn("oauth callback state did not match the pre-session cookie", {
      event: "oauth_callback_state_mismatch",
    });
    return authRedirectFailure("oauth_failed", traceId);
  }

  // Step 4 — exchange `code` for tokens (PKCE). `invalid_grant` (replayed /
  // expired code, verifier mismatch) → FS-01; a network timeout → a transient
  // "Salesforce unavailable" path.
  const exchangeCode: CodeExchanger =
    options.exchangeCode ??
    ((input) =>
      exchangeAuthorizationCode(
        input,
        options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {},
      ));
  let tokens: TokenExchangeResult;
  try {
    tokens = await exchangeCode({
      code,
      codeVerifier,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      redirectUri: config.redirectUri,
      loginUrl: config.loginUrl,
    });
  } catch (err) {
    const transient =
      err instanceof SalesforceError && err.code === "SF_NETWORK_TIMEOUT";
    log.warn("oauth callback code exchange failed", {
      event: "oauth_callback_exchange_failed",
      reason: err instanceof SalesforceError ? err.code : "unknown",
    });
    return authRedirectFailure(transient ? "sf_unavailable" : "oauth_failed", traceId);
  }

  // Step 4b — BR-01 least-privilege check: the granted scope must cover every
  // scope requested at /authorize. A narrower grant is a Connected App
  // misconfiguration — fail rather than run under-scoped.
  if (!grantedScopeCoversRequest(config.scope, tokens.scope)) {
    log.warn("oauth callback granted scope is narrower than requested", {
      event: "oauth_callback_scope_mismatch",
    });
    return authRedirectFailure("oauth_failed", traceId);
  }

  // Step 5 — the SF User Id (from the identity URL) is the first value that
  // identifies the specialist; from here a failure CAN be audited.
  let specialistId: string;
  try {
    specialistId = parseSalesforceUserId(tokens.identityUrl);
  } catch {
    log.warn("oauth callback could not parse the Salesforce identity URL", {
      event: "oauth_callback_identity_invalid",
    });
    return authRedirectFailure("oauth_failed", traceId);
  }

  const db = await resolveDb(options.db);
  const store = await resolveStore(options.store);

  // Resolve the role + identity from Salesforce (TR-AUTH-8). A missing
  // permission set is FS-02 ("access not provisioned"); a permission-set or
  // `User`-record query failure is transient. Both are audited — the
  // specialist id is known.
  const resolveSpecialist: SpecialistResolver =
    options.resolveSpecialist ?? defaultSpecialistResolver(config, options.fetchImpl);
  let specialist: ResolvedSpecialist;
  try {
    specialist = await resolveSpecialist({
      accessToken: tokens.accessToken,
      instanceUrl: tokens.instanceUrl,
      userId: specialistId,
    });
  } catch (err) {
    const missing = err instanceof RoleResolutionError;
    const reason = missing ? "permission_set_missing" : "sf_specialist_query_failed";
    await writeAuthFailure(db, specialistId, traceId, reason);
    log.warn("oauth callback could not resolve the specialist", {
      event: "oauth_callback_specialist_unresolved",
      reason,
    });
    return authRedirectFailure(missing ? "not_provisioned" : "sf_unavailable", traceId);
  }

  // Step 6 — encrypt the refresh token for at-rest storage (TR-AUTH-3,
  // SEC-AUTH-2). It never reaches the cookie, the response, or a log.
  const sfRefreshTokenEncrypted = aeadEncrypt(tokens.refreshToken, config.sfTokenEncKey);

  // Step 7 — create the session. `startSession` writes the `auth.session_start`
  // audit row (Immutable #5) BEFORE it returns, so the audit is durable before
  // this handler builds the 302.
  const ipAddress = parseClientIp(req);
  const userAgentHash = hashUserAgent(req.headers.get("user-agent"));
  let session: { token: string; sessionId: string };
  try {
    session = await startSession(store, db, config.session, {
      specialistId,
      role: specialist.role,
      displayName: specialist.displayName,
      email: specialist.email,
      timezone: specialist.timezone,
      ...(ipAddress !== undefined ? { ipAddress } : {}),
      userAgentHash,
      sfRefreshTokenEncrypted,
      traceId,
    });
  } catch (err) {
    // `startSession` failed — the session insert or the audit write. The same
    // DB may be down, so the failure audit is best-effort and never masks the
    // original error.
    log.error("oauth callback could not start the session", {
      event: "oauth_callback_session_start_failed",
      reason: errorReason(err),
    });
    await tryWriteAuthFailure(db, specialistId, traceId, "session_start_failed", log);
    return authRedirectFailure("sf_unavailable", traceId);
  }

  // Step 8 — the 302 success response. `returnTo` is re-validated here: it was
  // read back from a cookie that could be stale or hand-edited.
  const location = resolveLanding(returnTo);
  const headers = new Headers();
  headers.set("Location", location);
  headers.set("Cache-Control", "no-store");
  headers.set("X-Trace-Id", traceId);
  // The session cookie's Max-Age tracks the idle timeout (API §7.2.2); the
  // session ROW carries the 12 h absolute cap. `config.sessionCookie` is
  // `SameSite=None; Secure` in the deployed iframe (see callback-config).
  headers.append(
    "Set-Cookie",
    serializeSessionCookie(
      session.token,
      config.sessionCookie,
      config.session.idleTimeoutSeconds,
    ),
  );
  // Clear the single-use pre-session cookies — same path P1B-01 set them with,
  // or the browser keeps them (replay risk).
  const clearAttrs: OAuthCookieAttributes = {
    secure: config.oauthCookieSecure,
    sameSite: config.oauthCookieSameSite,
    path: OAUTH_COOKIE_PATH,
    maxAgeSeconds: 0,
  };
  headers.append("Set-Cookie", clearOAuthStateCookie(clearAttrs));
  headers.append("Set-Cookie", clearOAuthPkceCookie(clearAttrs));

  log.info("oauth callback completed a session start", {
    event: "oauth_callback_session_started",
  });
  return new Response(null, { status: 302, headers });
}

// Build the default specialist resolver: a per-specialist `SalesforceAuth`
// carrying the freshly-minted access token, wrapped in a `SalesforceRestClient`.
function defaultSpecialistResolver(
  config: AuthCallbackConfig,
  fetchImpl: typeof fetch | undefined,
): SpecialistResolver {
  return async ({ accessToken, instanceUrl, userId }) => {
    const auth: SalesforceAuth = {
      getAccessToken: () => Promise.resolve(accessToken),
      getInstanceUrl: () => Promise.resolve(instanceUrl),
    };
    const client = new SalesforceRestClient({
      auth,
      ...(fetchImpl !== undefined ? { fetchImpl } : {}),
    });
    // `ROLES` is ordered SPECIALIST → SYSTEM_ADMIN — exactly the low→high
    // privilege order the resolver's multi-assignment tie-break needs. The two
    // queries (PermissionSetAssignment, then the `User` record) reuse one REST
    // client; login is not a hot path, so two round-trips is acceptable.
    const role = await resolveRoleFromPermissionSet(
      client,
      userId,
      config.rolePermissionSets,
      ROLES,
    );
    const identity = await fetchSalesforceUserIdentity(client, userId);
    return { role, ...identity };
  };
}

// Write an `auth.failure` audit row. `reason` is a short controlled enum
// string — never a token, a `code`, an SF id, or any PII (`assertNoPii` in the
// writer would reject those anyway).
async function writeAuthFailure(
  db: DbOrTx,
  specialistId: string,
  traceId: string,
  reason: string,
): Promise<void> {
  await writeAuditEntry(db, {
    specialistId,
    actionType: "auth.failure",
    outcome: "FAILED",
    payloadMetadata: { reason },
    traceId,
  });
}

// Best-effort `auth.failure` for the post-`startSession`-failure path: the DB
// that `startSession` just failed against may be unreachable, so a second
// failure here is logged, not thrown — it must not mask the original error.
async function tryWriteAuthFailure(
  db: DbOrTx,
  specialistId: string,
  traceId: string,
  reason: string,
  log: StructuredLogger,
): Promise<void> {
  try {
    await writeAuthFailure(db, specialistId, traceId, reason);
  } catch (err) {
    log.error("oauth callback could not write the auth.failure audit row", {
      event: "oauth_callback_audit_write_failed",
      reason: errorReason(err),
    });
  }
}

// Constant-time string comparison. A length mismatch short-circuits (the OAuth
// `state` is a fixed-length token, so length is not a secret) — `timingSafe-
// Equal` itself throws on unequal-length buffers.
function timingSafeEqualStrings(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) {
    return false;
  }
  return timingSafeEqual(ab, bb);
}

// BR-01: every scope requested at /authorize must appear in the granted scope.
// An empty granted scope is a deliberate soft pass: RFC 6749 §5.1 makes the
// token response's `scope` field OPTIONAL when it is identical to the request,
// so an omitted/empty `scope` cannot be read as "narrowed". The two scopes
// that actually matter are still verified downstream regardless — a missing
// `refresh_token` throws in `exchangeAuthorizationCode`, and a denied `api`
// scope fails the permission-set SOQL query.
function grantedScopeCoversRequest(requested: string, granted: string): boolean {
  const grantedTokens = new Set(granted.split(/\s+/).filter((s) => s.length > 0));
  if (grantedTokens.size === 0) {
    return true;
  }
  return requested
    .split(/\s+/)
    .filter((s) => s.length > 0)
    .every((token) => grantedTokens.has(token));
}

// The client IP for the `sessions.ip_address` (`inet`) column, from the first
// `X-Forwarded-For` hop. Only a plausibly-shaped value is persisted — a
// non-IP literal would make the `inet` insert throw.
function parseClientIp(req: Request): string | undefined {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded === null || forwarded.length === 0) {
    return undefined;
  }
  const first = (forwarded.split(",")[0] ?? "").trim();
  if (first.length === 0) {
    return undefined;
  }
  // Flat alternation-free patterns — no nested quantifiers (ReDoS-safe).
  const isIpv4 = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(first);
  const isIpv6Shaped = /^[0-9a-fA-F:]+$/.test(first) && first.includes(":");
  return isIpv4 || isIpv6Shaped ? first : undefined;
}

// Resolve the post-login `Location`. `returnTo` rode the encrypted state cookie
// — re-validate it (a stale/edited cookie is not trusted) and fall back to `/`.
function resolveLanding(returnTo: string | undefined): string {
  const result = validateReturnTo(returnTo ?? null);
  return result.kind === "valid" ? result.value : DEFAULT_LANDING;
}

function errorReason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
