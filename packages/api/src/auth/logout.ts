// POST /api/v1/auth/logout (endpoint E-04) — terminates the opaque session
// P1B-02 minted (F-01, TR-AUTH-9, SEC-AUTH-9, SEC-AUDIT-1a/7, ARC-13,
// Immutable #5/#6). The handler:
//   1. resolves the current session from the `anthos_session` cookie. An
//      absent / unknown / forged cookie is a graceful no-op (API §7.2.4 + the
//      ticket AC): logout is the one endpoint where "no session" still
//      succeeds — the caller wanted to be logged out and now is.
//   2. when a session row resolves (active OR already revoked), runs the
//      revoke under `withIdempotency` (Pattern D / Immutable #6) keyed by the
//      specialist. `revokeSession` soft-revokes the row, wipes the stored
//      Salesforce refresh token, and writes the `auth.session_end` audit row
//      BEFORE this handler builds its 204 (Immutable #5). An already-revoked
//      session is a no-op there — no duplicate `auth.session_end`.
//   3. clears the `anthos_session` cookie with the SAME attributes P1B-02 set
//      it with, and returns 204 No Content (API §7.2.4).
//
// All business logic lives here so it is unit-testable without a Next runtime;
// `apps/web` carries only a thin route shim. The session is read directly from
// the cookie, NOT via `withSession`: `withSession` 401s an absent / revoked /
// expired session, which would defeat the graceful-no-op AC.
//
// Out of scope (Demo Mode): the Salesforce-side `/services/oauth2/revoke` call
// — a Production Readiness Ratchet item; Demo Mode clears server-side state
// only. No secret, session id, or token ever reaches a log line or the
// response body / headers.

import { clearSessionCookie, hashToken, parseSessionCookie } from "@anthos/auth";
import type { CookieAttributes } from "@anthos/auth";
import { createLogger, resolveTraceId } from "@anthos/logging";
import type { StructuredLogger } from "@anthos/logging";
import type { DbOrTx } from "@anthos/persistence";

import { withIdempotency } from "../idempotency/index.js";
import type {
  IdempotencyStore,
  IdempotentHandler,
  RequestContext,
} from "../idempotency/index.js";
import { enforceOrigin } from "../origin/index.js";
import type { OriginConfig } from "../origin/index.js";
import { revokeSession } from "../session/service.js";
import type { SessionStore } from "../session/store.js";
import { loadAuthLogoutConfig } from "./logout-config.js";
import type { AuthLogoutConfig } from "./logout-config.js";
import { authErrorResponse } from "./responses.js";

// Structured logger for this endpoint; a per-request child binds trace_id.
const defaultLogger = createLogger({ module: "api.auth" });

// The `reason` stamped on the revoked `sessions` row and echoed in the
// `auth.session_end` audit payload — a short controlled string, never PII.
const LOGOUT_REASON = "logout";

export interface AuthLogoutOptions {
  // Injected for tests — defaults to `loadAuthLogoutConfig()` (memoized).
  readonly config?: AuthLogoutConfig;
  // Injected for tests — defaults to the lazily-resolved Postgres store.
  readonly store?: SessionStore;
  // Injected for tests — defaults to the lazily-resolved default DB handle.
  readonly db?: DbOrTx;
  // Injected for tests — defaults to `withIdempotency`'s own Postgres store.
  readonly idempotencyStore?: IdempotencyStore;
  // Injected for tests — defaults to the `api.auth` logger.
  readonly logger?: StructuredLogger;
  // Injected for tests — the CSRF Origin allowlist. Defaults to the memoized
  // env-driven `loadOriginConfig()` inside `enforceOrigin`.
  readonly originConfig?: OriginConfig;
}

// Memoized default config — `loadAuthLogoutConfig` reads `process.env`, fixed
// at boot. A throw is NOT memoized, so a misconfigured deploy keeps failing
// loudly per request.
let defaultConfig: AuthLogoutConfig | undefined;

function resolveConfig(injected: AuthLogoutConfig | undefined): AuthLogoutConfig {
  if (injected !== undefined) {
    return injected;
  }
  defaultConfig ??= loadAuthLogoutConfig();
  return defaultConfig;
}

// Lazily-resolved, memoized defaults. The dynamic imports keep the
// @anthos/persistence connection side effect out of @anthos/api's static
// import graph (mirrors the refresh handler). Tests inject the seams so this
// DB-backed path is never reached.
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

// The full E-04 handler. Resolves trace_id + config, then runs the logout.
export async function handleAuthLogout(
  req: Request,
  options: AuthLogoutOptions = {},
): Promise<Response> {
  const traceId = resolveTraceId(req);
  const log = (options.logger ?? defaultLogger).child({ traceId });

  // Config: a malformed `ANTHOS_SESSION_*` var is operator error → 500. The
  // thrown message names the env var (safe) and is logged only, never echoed.
  let config: AuthLogoutConfig;
  try {
    config = resolveConfig(options.config);
  } catch (err) {
    log.error("oauth logout configuration error", {
      event: "oauth_logout_config_error",
      reason: errorReason(err),
    });
    return authErrorResponse("AUTH_CONFIG_ERROR", traceId);
  }

  try {
    return await runLogout(req, options, config, log, traceId);
  } catch (err) {
    // Safety net for an unexpected throw — no silent catch. Logout
    // has no Salesforce dependency; reaching here is an internal / DB fault, so
    // it returns the API §9.2.2 catalog code `INTERNAL_ERROR` (500) — distinct
    // from `AUTH_CONFIG_ERROR` (operator misconfiguration). The real reason is
    // logged under the trace id, never echoed.
    log.error("oauth logout failed unexpectedly", {
      event: "oauth_logout_internal_error",
      reason: errorReason(err),
    });
    return authErrorResponse("INTERNAL_ERROR", traceId);
  }
}

async function runLogout(
  req: Request,
  options: AuthLogoutOptions,
  config: AuthLogoutConfig,
  log: StructuredLogger,
  traceId: string,
): Promise<Response> {
  // CSRF Origin check (API §8.6 / SEC-THREAT-1) — the first gate on a
  // mutation. A mismatched / absent `Origin` is rejected with 403
  // `CSRF_ORIGIN_MISMATCH` BEFORE any cookie parse, DB round-trip, or
  // idempotency lock; `enforceOrigin` writes the security audit row first
  // (Immutable #5). `getDb` is invoked only on that reject path, so the
  // no-cookie graceful no-op below stays DB-free.
  const originRejection = await enforceOrigin(req, {
    ...(options.originConfig !== undefined ? { config: options.originConfig } : {}),
    getDb: () => resolveDb(options.db),
    traceId,
    logger: log,
  });
  if (originRejection !== null) {
    return originRejection;
  }

  // Resolve the session from the `anthos_session` cookie. An absent cookie is
  // a graceful no-op — nothing to terminate, but the caller is now logged out
  // (API §7.2.4 + ticket AC). Parsed BEFORE the DB-backed stores resolve, so
  // the no-cookie case never makes a DB round-trip; idempotency is skipped
  // too — there is no mutation and no audit row to make idempotent.
  const rawToken = parseSessionCookie(req.headers.get("Cookie"));
  if (rawToken === null) {
    log.info("oauth logout: no session cookie — graceful no-op", {
      event: "oauth_logout_no_cookie",
    });
    return logoutResponse(config.sessionCookie, traceId);
  }
  const tokenHash = hashToken(rawToken);

  const store = await resolveStore(options.store);
  const db = await resolveDb(options.db);

  const session = await store.getByTokenHash(tokenHash);
  if (session === null) {
    // Unknown / forged / already-swept token — nothing to terminate.
    log.info("oauth logout: session not found — graceful no-op", {
      event: "oauth_logout_session_absent",
    });
    return logoutResponse(config.sessionCookie, traceId);
  }

  // A session row exists (active OR already revoked) — `specialistId` is
  // available, so run the audited revoke under the idempotency wrapper
  // (Pattern D / Immutable #6). A replay returns the stored 204 without
  // re-running the core; `revokeSession` itself no-ops an already-revoked
  // session, so no duplicate `auth.session_end` is written.
  const core = buildLogoutCore({ store, db, tokenHash, config, log });
  const idempotencyOptions =
    options.idempotencyStore !== undefined
      ? { store: options.idempotencyStore }
      : {};
  const ctx: RequestContext = { specialistId: session.specialistId };
  return withIdempotency(core, idempotencyOptions)(req, ctx);
}

interface LogoutCoreDeps {
  readonly store: SessionStore;
  readonly db: DbOrTx;
  readonly tokenHash: string;
  readonly config: AuthLogoutConfig;
  readonly log: StructuredLogger;
}

// Build the idempotency-wrapped core. `revokeSession` owns the audit-before-
// response invariant: it writes `auth.session_end` (when the session is still
// active) BEFORE this core returns its 204 (Immutable #5). The 204 is returned
// in every case — logout is graceful whether or not it actually revoked.
function buildLogoutCore(deps: LogoutCoreDeps): IdempotentHandler {
  const { store, db, tokenHash, config, log } = deps;

  return async (_req, ctx) => {
    const { traceId } = ctx;
    const revoked = await revokeSession(store, db, tokenHash, LOGOUT_REASON, traceId);
    log.info(
      revoked
        ? "oauth logout terminated the session"
        : "oauth logout: session already terminated — no-op",
      { event: revoked ? "oauth_logout_completed" : "oauth_logout_noop" },
    );
    return logoutResponse(config.sessionCookie, traceId);
  };
}

// Build the 204 response (API §7.2.4). Clears the `anthos_session` cookie with
// the SAME attributes P1B-02 set it with (`clearSessionCookie` reuses the
// shared `CookieAttributes`), so the browser actually overwrites it.
// `Cache-Control: no-store` + `X-Trace-Id` are re-applied by the idempotency
// wrapper on the mutating path; set here too so the un-wrapped no-op paths are
// equally correct.
function logoutResponse(cookie: CookieAttributes, traceId: string): Response {
  const headers = new Headers();
  headers.set("Cache-Control", "no-store");
  headers.set("X-Trace-Id", traceId);
  headers.append("Set-Cookie", clearSessionCookie(cookie));
  return new Response(null, { status: 204, headers });
}

function errorReason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
