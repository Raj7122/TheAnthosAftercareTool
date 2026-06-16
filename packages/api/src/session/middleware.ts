// Session middleware (ADR-03 / ARC-13 / F-01). `withSession` is the outermost
// wrapper on an authenticated route: it resolves the opaque `anthos_session`
// cookie, loads the session, enforces the idle (GAP-11) and absolute
// (SEC-AUTH-11) timeouts, and short-circuits to 401 on expiry / revocation.
//
// Audit: the middleware writes NO audit rows. A 401 short-circuit is
// structured-logged (correlation IDs only — never the raw cookie). The three
// audited lifecycle events (auth.session_start / _refresh / _end) belong to
// the service functions, not this read path — auditing every request would
// flood the ledger. P1A-06 routed these rejection events onto the structured
// logger; a rejected request is not a state mutation, so no audit_log row.

import {
  evaluateSession,
  hashToken,
  loadSessionConfig,
  parseSessionCookie,
} from "@anthos/auth";
import type { Role, SessionConfig } from "@anthos/auth";
import {
  createLogger,
  echoTraceId,
  forwardWithTraceId,
  resolveTraceId,
} from "@anthos/logging";
import type { StructuredLogger } from "@anthos/logging";

import type { RequestContext } from "../idempotency/index.js";
import { sessionErrorResponse } from "./responses.js";
import type { SessionStore } from "./store.js";

// The session-id prefix length carried in rejection logs — a short prefix
// disambiguates the session while staying clear of the PII firewall's value
// heuristics; the full id lives on the sessions row.
const SESSION_ID_LOG_PREFIX_LENGTH = 8;

// Structured logger for this middleware (@anthos/logging — P1A-06). A 401
// short-circuit binds only trace_id — correlation IDs only, no specialist id.
const defaultLogger = createLogger({ module: "api.session" });

// Context the middleware resolves and passes down. Extends the idempotency
// `RequestContext` (`specialistId`) so `withSession(withIdempotency(handler))`
// composes with no signature change — withIdempotency consumes `specialistId`
// and ignores the extra fields.
export interface SessionRequestContext extends RequestContext {
  readonly role: Role;
  readonly sessionId: string;
  readonly traceId: string;
  // Absolute session expiry — surfaced so a handler (e.g. `GET /me`, E-05) can
  // report `sessionExpiresAt` without re-reading the session row.
  readonly expiresAt: Date;
  // The signed-in specialist's own identity, resolved at session start and
  // carried on the session row (P1B-05). Null on a session minted before the
  // identity-capture migration — a consuming handler decides how to treat that.
  readonly displayName: string | null;
  readonly email: string | null;
  readonly timezone: string | null;
}

export type SessionHandler = (
  req: Request,
  ctx: SessionRequestContext,
) => Promise<Response>;

export interface WithSessionOptions {
  // Injectable store — defaults to the Demo-Mode Postgres store, resolved
  // lazily so the DB connection side effect stays out of the static import
  // graph. Tests inject an in-memory fake.
  readonly store?: SessionStore;
  // Injectable config — defaults to `loadSessionConfig()` (env-driven).
  readonly config?: SessionConfig;
  // Injectable structured logger — defaults to the `api.session` logger.
  // Tests inject a spy to assert on rejection events.
  readonly logger?: StructuredLogger;
}

// Lazily resolved, memoized default store. The dynamic import keeps the DB
// connection side effect out of @anthos/api's static import graph. Tests MUST
// inject `options.store` so this DB-backed path is never reached.
let defaultStorePromise: Promise<SessionStore> | undefined;

async function resolveDefaultStore(): Promise<SessionStore> {
  defaultStorePromise ??= import("./postgres-store.js").then((m) =>
    m.createDefaultPostgresStore(),
  );
  return defaultStorePromise;
}

// Memoized default config — `loadSessionConfig` reads `process.env`, which is
// fixed at boot, so resolving it once per process is sufficient.
let defaultConfig: SessionConfig | undefined;

function resolveConfig(injected: SessionConfig | undefined): SessionConfig {
  if (injected !== undefined) {
    return injected;
  }
  defaultConfig ??= loadSessionConfig();
  return defaultConfig;
}

// Structured log for a 401 short-circuit. Correlation IDs only — never the raw
// cookie token, never a specialist identifier. `log` already binds trace_id.
// `sessionId` is null when no row resolved (absent / unknown cookie); when
// present only a short prefix is logged (the full id lives on the sessions row).
function logRejection(
  log: StructuredLogger,
  event: string,
  sessionId: string | null,
): void {
  const fields: Record<string, unknown> = { event };
  if (sessionId !== null) {
    fields.session_id_prefix = sessionId.slice(0, SESSION_ID_LOG_PREFIX_LENGTH);
  }
  log.warn(`session middleware rejection: ${event}`, fields);
}

export function withSession(
  handler: SessionHandler,
  options: WithSessionOptions = {},
): (req: Request) => Promise<Response> {
  return async (req) => {
    const traceId = resolveTraceId(req);
    const log = (options.logger ?? defaultLogger).child({ traceId });
    const store = options.store ?? (await resolveDefaultStore());
    const config = resolveConfig(options.config);
    const now = new Date();

    const rawToken = parseSessionCookie(req.headers.get("Cookie"));
    if (rawToken === null) {
      logRejection(log, "session_cookie_absent", null);
      return sessionErrorResponse("AUTH_SESSION_INVALID", traceId);
    }

    // Look the session up by the SHA-256 of the cookie token — the plaintext
    // token is never compared in application code, only its hash.
    const tokenHash = hashToken(rawToken);
    const session = await store.getByTokenHash(tokenHash);
    if (session === null) {
      logRejection(log, "session_not_found", null);
      return sessionErrorResponse("AUTH_SESSION_INVALID", traceId);
    }

    const evaluation = evaluateSession(session, now, config);
    if (evaluation.status === "revoked") {
      logRejection(log, "session_revoked", session.id);
      return sessionErrorResponse("AUTH_SESSION_INVALID", traceId);
    }
    if (
      evaluation.status === "idle_expired" ||
      evaluation.status === "absolute_expired"
    ) {
      logRejection(log, `session_${evaluation.status}`, session.id);
      const details =
        evaluation.expiredAt === null
          ? undefined
          : { expiredAt: evaluation.expiredAt.toISOString() };
      return sessionErrorResponse("AUTH_SESSION_EXPIRED", traceId, details);
    }

    // active — heartbeat the idle clock (benign housekeeping, not audited),
    // then run the handler with the resolved context.
    await store.touch(tokenHash, now);
    const ctx: SessionRequestContext = {
      specialistId: session.specialistId,
      role: session.role,
      sessionId: session.id,
      traceId,
      expiresAt: session.expiresAt,
      displayName: session.displayName,
      email: session.email,
      timezone: session.timezone,
    };
    const res = await handler(forwardWithTraceId(req, traceId), ctx);
    return echoTraceId(res, traceId);
  };
}
