// POST /api/v1/auth/refresh (endpoint E-03) — the server side of the proactive
// OAuth token refresh (F-01, TR-AUTH-3/4/6/9, SEC-AUTH-2/6, ARC-13/14,
// Immutable #3). The client calls this at 80% of the access-token TTL; the
// handler:
//   1. resolves the current session from the `anthos_session` cookie — a
//      soft-expired (idle-expired) session IS accepted, a revoked or
//      absolutely-expired one is not (API §6 E-03; SEC-AUTH-11);
//   2. rate-limits to 1 request per 5s per specialist (API §6 — anti-loop);
//   3. exchanges the stored Salesforce refresh token for a fresh access token
//      and, when the Connected App rotates, a fresh refresh token (SEC-AUTH-6);
//   4. atomically advances the idle clock and persists any rotated refresh
//      token via `refreshSession`, which writes the `auth.session_refresh`
//      audit row BEFORE this handler builds its 200 (Immutable #5);
//   5. re-issues the `anthos_session` cookie (same token, refreshed Max-Age).
//
// All business logic lives here so it is unit-testable without a Next runtime;
// `apps/web` carries only a thin route shim. The core mutation is wrapped by
// `withIdempotency` (Immutable #6 / Pattern D): a replay returns the stored 200
// without re-rotating. API §6 marks E-03 `Idem: N`, but Immutable #6 (top
// precedence rank) and the ticket DoD govern — the discrepancy is in the PR.
//
// Secrets posture: the stored refresh token, the freshly-minted access token,
// and any rotated refresh token never reach a log line, a URL, the response
// body or headers, or `payload_metadata`.

import {
  aeadDecrypt,
  aeadEncrypt,
  hashToken,
  parseSessionCookie,
  serializeSessionCookie,
} from "@anthos/auth";
import { writeAuditEntry } from "@anthos/audit";
import { exchangeRefreshToken, SalesforceError } from "@anthos/integrations";
import type {
  RefreshTokenExchangeInput,
  RefreshTokenExchangeResult,
} from "@anthos/integrations";
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
import { rateLimitErrorResponse } from "../ratelimit/index.js";
import type { RateLimiter } from "../ratelimit/index.js";
import { sessionErrorResponse } from "../session/responses.js";
import { refreshSession } from "../session/service.js";
import type { SessionRecord, SessionStore } from "../session/store.js";
import { loadAuthRefreshConfig } from "./refresh-config.js";
import type { AuthRefreshConfig } from "./refresh-config.js";
import { authErrorResponse } from "./responses.js";

// API §6 E-03 row: 1 request per 5s per specialist. The window and budget are
// constants — not a fixed buffer hack — so the limit is auditable in one place.
const RATE_LIMIT_WINDOW_SECONDS = 5;
const RATE_LIMIT_BUDGET = 1;
// The rate-limit key scope — namespaced so other endpoints can share the table.
const RATE_LIMIT_SCOPE = "auth.refresh";

// Structured logger for this endpoint; a per-request child binds trace_id.
const defaultLogger = createLogger({ module: "api.auth" });

// Exchange the refresh token → tokens. The default wraps `exchangeRefreshToken`;
// tests inject a stub.
export type RefreshTokenExchanger = (
  input: RefreshTokenExchangeInput,
) => Promise<RefreshTokenExchangeResult>;

export interface AuthRefreshOptions {
  // Injected for tests — defaults to `loadAuthRefreshConfig()` (memoized).
  readonly config?: AuthRefreshConfig;
  // Injected for tests — defaults to the lazily-resolved Postgres store.
  readonly store?: SessionStore;
  // Injected for tests — defaults to the lazily-resolved default DB handle.
  readonly db?: DbOrTx;
  // Injected for tests — defaults to the lazily-resolved Postgres rate limiter.
  readonly rateLimiter?: RateLimiter;
  // Injected for tests — defaults to `withIdempotency`'s own Postgres store.
  readonly idempotencyStore?: IdempotencyStore;
  // Injected for tests — defaults to the `api.auth` logger.
  readonly logger?: StructuredLogger;
  // Injected for tests — the CSRF Origin allowlist. Defaults to the memoized
  // env-driven `loadOriginConfig()` inside `enforceOrigin`.
  readonly originConfig?: OriginConfig;
  // Threaded into the SF token exchange. Defaults to global `fetch`.
  readonly fetchImpl?: typeof fetch;
  // Unit-test seam — stub the Salesforce refresh-token round-trip outright.
  readonly exchangeRefreshToken?: RefreshTokenExchanger;
}

// Memoized default config — `loadAuthRefreshConfig` reads `process.env`, fixed
// at boot. A throw is NOT memoized, so a misconfigured deploy keeps failing
// loudly per request.
let defaultConfig: AuthRefreshConfig | undefined;

function resolveConfig(injected: AuthRefreshConfig | undefined): AuthRefreshConfig {
  if (injected !== undefined) {
    return injected;
  }
  defaultConfig ??= loadAuthRefreshConfig();
  return defaultConfig;
}

// Lazily-resolved, memoized defaults. The dynamic imports keep the
// @anthos/persistence connection side effect out of @anthos/api's static
// import graph (mirrors the callback handler). Tests inject the seams so this
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

let defaultRateLimiterPromise: Promise<RateLimiter> | undefined;

async function resolveRateLimiter(
  injected: RateLimiter | undefined,
): Promise<RateLimiter> {
  if (injected !== undefined) {
    return injected;
  }
  defaultRateLimiterPromise ??= import("../ratelimit/postgres-store.js").then((m) =>
    m.createDefaultPostgresRateLimiter(),
  );
  return defaultRateLimiterPromise;
}

// The full E-03 handler. Resolves trace_id + config, resolves the session, then
// runs the rate-limited, idempotent refresh core.
export async function handleAuthRefresh(
  req: Request,
  options: AuthRefreshOptions = {},
): Promise<Response> {
  const traceId = resolveTraceId(req);
  const log = (options.logger ?? defaultLogger).child({ traceId });

  // Config: a missing / malformed env var is operator error → 500. The thrown
  // message names the env var (safe) and is logged only, never echoed.
  let config: AuthRefreshConfig;
  try {
    config = resolveConfig(options.config);
  } catch (err) {
    log.error("oauth refresh configuration error", {
      event: "oauth_refresh_config_error",
      reason: errorReason(err),
    });
    return authErrorResponse("AUTH_CONFIG_ERROR", traceId);
  }

  try {
    return await runRefresh(req, options, config, log, traceId);
  } catch (err) {
    // Safety net for an unexpected throw — no silent catch. Every
    // real failure mode has its own branch below; reaching here is an infra
    // fault. 503 (not 401) — an unknown transient must never force a spurious
    // re-login of a session that may be perfectly valid.
    log.error("oauth refresh failed unexpectedly", {
      event: "oauth_refresh_internal_error",
      reason: errorReason(err),
    });
    return authErrorResponse("SF_UPSTREAM_UNAVAILABLE", traceId);
  }
}

async function runRefresh(
  req: Request,
  options: AuthRefreshOptions,
  config: AuthRefreshConfig,
  log: StructuredLogger,
  traceId: string,
): Promise<Response> {
  // Step 0 — CSRF Origin check (API §8.6 / SEC-THREAT-1). A mismatched /
  // absent `Origin` is rejected with 403 `CSRF_ORIGIN_MISMATCH` BEFORE the
  // cookie parse, the rate-limit consume, and the idempotency lock — so a
  // CSRF-rejected request burns no rate budget and no idempotency key.
  // `enforceOrigin` writes the security audit row first (Immutable #5);
  // `getDb` is invoked only on that reject path.
  const originRejection = await enforceOrigin(req, {
    ...(options.originConfig !== undefined ? { config: options.originConfig } : {}),
    getDb: () => resolveDb(options.db),
    traceId,
    logger: log,
  });
  if (originRejection !== null) {
    return originRejection;
  }

  // Step 1 — resolve the session from the `anthos_session` cookie. A soft-
  // expired (idle-expired) session is still refreshable; a revoked or
  // absolutely-expired one is not (API §6 E-03; SEC-AUTH-11). The cookie is
  // parsed BEFORE the DB-backed stores resolve, so a malformed request fails
  // fast without a DB round-trip. The session resolves OUTSIDE the idempotency
  // wrapper because the idempotency lock is keyed by specialist — which this
  // step is what produces.
  const rawToken = parseSessionCookie(req.headers.get("Cookie"));
  if (rawToken === null) {
    logRejection(log, "session_cookie_absent");
    return sessionErrorResponse("AUTH_SESSION_INVALID", traceId);
  }
  const tokenHash = hashToken(rawToken);

  const store = await resolveStore(options.store);
  const db = await resolveDb(options.db);
  const rateLimiter = await resolveRateLimiter(options.rateLimiter);

  const session = await store.getByTokenHash(tokenHash);
  if (session === null) {
    logRejection(log, "session_not_found");
    return sessionErrorResponse("AUTH_SESSION_INVALID", traceId);
  }
  if (session.revoked) {
    logRejection(log, "session_revoked");
    return sessionErrorResponse("AUTH_SESSION_INVALID", traceId);
  }
  if (Date.now() >= session.expiresAt.getTime()) {
    // Past the 12h absolute cap — not refreshable (a soft-expired session is).
    logRejection(log, "session_absolute_expired");
    return sessionErrorResponse("AUTH_SESSION_INVALID", traceId);
  }

  // Step 2 — run the rate-limited rotation core under the idempotency wrapper
  // (Pattern D). A replay returns the stored 200 without re-rotating; the core
  // runs at most once per Idempotency-Key, so its audit row is written once.
  const core = buildRefreshCore({
    config,
    store,
    db,
    rateLimiter,
    session,
    tokenHash,
    rawToken,
    exchanger: resolveExchanger(options),
    log,
  });
  const idempotencyOptions =
    options.idempotencyStore !== undefined
      ? { store: options.idempotencyStore }
      : {};
  const ctx: RequestContext = { specialistId: session.specialistId };
  return withIdempotency(core, idempotencyOptions)(req, ctx);
}

interface RefreshCoreDeps {
  readonly config: AuthRefreshConfig;
  readonly store: SessionStore;
  readonly db: DbOrTx;
  readonly rateLimiter: RateLimiter;
  readonly session: SessionRecord;
  readonly tokenHash: string;
  readonly rawToken: string;
  readonly exchanger: RefreshTokenExchanger;
  readonly log: StructuredLogger;
}

// Build the idempotency-wrapped core. It owns the audit-before-response
// invariant: every exit path writes its audit row (`auth.session_refresh` on
// success, `auth.failure` otherwise) BEFORE the Response is returned.
function buildRefreshCore(deps: RefreshCoreDeps): IdempotentHandler {
  const { config, store, db, rateLimiter, session, tokenHash, rawToken, exchanger, log } =
    deps;

  return async (_req, ctx) => {
    const { traceId } = ctx;
    const { specialistId } = session;

    // Step 2a — rate limit (API §6: 1 per 5s per specialist; anti-loop). A 429
    // is an audited auth event (SEC-AUDIT-7).
    const limit = await rateLimiter.checkAndConsume(
      `${RATE_LIMIT_SCOPE}:${specialistId}`,
      RATE_LIMIT_WINDOW_SECONDS,
    );
    if (!limit.allowed) {
      await writeAuthFailure(db, specialistId, traceId, "rate_limited");
      log.warn("oauth refresh rate limit exceeded", {
        event: "oauth_refresh_rate_limited",
      });
      return rateLimitErrorResponse(traceId, {
        retryAfterSeconds: limit.retryAfterSeconds ?? RATE_LIMIT_WINDOW_SECONDS,
        limit: RATE_LIMIT_BUDGET,
      });
    }

    // Step 2b — read the stored Salesforce refresh token. Absent means the
    // session predates the exchange or the credential was cleared — not
    // refreshable.
    const ciphertext = await store.getSalesforceRefreshToken(tokenHash);
    if (ciphertext === null) {
      await writeAuthFailure(db, specialistId, traceId, "refresh_token_absent");
      log.warn("oauth refresh has no stored Salesforce refresh token", {
        event: "oauth_refresh_token_absent",
      });
      return sessionErrorResponse("AUTH_SESSION_INVALID", traceId);
    }

    // Step 2c — decrypt the refresh token. A decrypt failure (tampered or
    // key-rotated ciphertext) is a dead credential — not refreshable.
    let refreshToken: string;
    try {
      refreshToken = aeadDecrypt(ciphertext, config.sfTokenEncKey);
    } catch {
      await writeAuthFailure(
        db,
        specialistId,
        traceId,
        "refresh_token_decrypt_failed",
      );
      log.warn("oauth refresh could not decrypt the stored refresh token", {
        event: "oauth_refresh_token_decrypt_failed",
      });
      return sessionErrorResponse("AUTH_SESSION_INVALID", traceId);
    }

    // Step 2d — exchange the refresh token against Salesforce. `invalid_grant`
    // (the refresh token is revoked/expired) is terminal → 401; a network
    // timeout is transient → 503 (the idempotency wrapper releases the lock so
    // a retry can re-run).
    let tokens: RefreshTokenExchangeResult;
    try {
      tokens = await exchanger({
        refreshToken,
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        loginUrl: config.loginUrl,
      });
    } catch (err) {
      const transient =
        err instanceof SalesforceError && err.code === "SF_NETWORK_TIMEOUT";
      const reason = transient ? "sf_unavailable" : "refresh_token_invalid";
      await writeAuthFailure(db, specialistId, traceId, reason);
      log.warn("oauth refresh token exchange failed", {
        event: "oauth_refresh_exchange_failed",
        reason: err instanceof SalesforceError ? err.code : "unknown",
      });
      return transient
        ? authErrorResponse("SF_UPSTREAM_UNAVAILABLE", traceId)
        : sessionErrorResponse("AUTH_SESSION_INVALID", traceId);
    }

    // Step 2e — when Salesforce rotated the refresh token (SEC-AUTH-6),
    // re-encrypt the new one for at-rest storage. The freshly-minted access
    // token is transient: it proves the OAuth grant is alive, then is dropped
    // (no `sessions` access-token column — see the P1B-03 ticket).
    const rotatedRefreshTokenEncrypted =
      tokens.refreshToken !== undefined
        ? aeadEncrypt(tokens.refreshToken, config.sfTokenEncKey)
        : undefined;

    // Step 2f — apply the refresh: advance the idle clock, persist any rotated
    // token (atomic, single store call), and write `auth.session_refresh`
    // BEFORE this core returns its Response (Immutable #5). `null` means the
    // session was revoked / hit its absolute cap between Step 1 and now.
    const refreshed = await refreshSession(
      store,
      db,
      tokenHash,
      traceId,
      rotatedRefreshTokenEncrypted !== undefined
        ? { rotatedRefreshTokenEncrypted }
        : {},
    );
    if (refreshed === null) {
      await writeAuthFailure(db, specialistId, traceId, "session_unrefreshable");
      logRejection(log, "session_unrefreshable");
      return sessionErrorResponse("AUTH_SESSION_INVALID", traceId);
    }

    log.info("oauth refresh completed a session refresh", {
      event: "oauth_refresh_completed",
    });
    return successResponse(refreshed, rawToken, config, traceId);
  };
}

// Build the 200 response (API §7.2.3). Re-issues the `anthos_session` cookie —
// the opaque session token is unchanged, but the refreshed `Max-Age` keeps the
// browser cookie alive across the idle window (the cookie is otherwise never
// re-set after login). `Cache-Control: no-store` + `X-Trace-Id` are added by
// the idempotency wrapper; set here too so a direct (un-wrapped) call is correct.
function successResponse(
  session: SessionRecord,
  rawToken: string,
  config: AuthRefreshConfig,
  traceId: string,
): Response {
  const headers = new Headers();
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set("X-Trace-Id", traceId);
  headers.append(
    "Set-Cookie",
    serializeSessionCookie(
      rawToken,
      config.sessionCookie,
      config.session.idleTimeoutSeconds,
    ),
  );
  return new Response(
    JSON.stringify({
      sessionExpiresAt: session.expiresAt.toISOString(),
      idleTimeoutSeconds: config.session.idleTimeoutSeconds,
    }),
    { status: 200, headers },
  );
}

// Build the default exchanger: wrap `exchangeRefreshToken`, threading the
// injectable `fetchImpl`. Tests pass `options.exchangeRefreshToken` instead.
function resolveExchanger(options: AuthRefreshOptions): RefreshTokenExchanger {
  if (options.exchangeRefreshToken !== undefined) {
    return options.exchangeRefreshToken;
  }
  return (input) =>
    exchangeRefreshToken(
      input,
      options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {},
    );
}

// Write an `auth.failure` audit row (SEC-AUDIT-7). `reason` is a short
// controlled enum string — never a token, an SF id, or any PII (`assertNoPii`
// in the writer would reject those anyway).
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

// Structured log for a refresh rejection. Correlation IDs only — never the raw
// cookie token, never a specialist identifier. `log` already binds trace_id.
function logRejection(log: StructuredLogger, event: string): void {
  log.warn(`oauth refresh rejection: ${event}`, { event });
}

function errorReason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
