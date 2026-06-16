// POST /api/v1/queue/sync (endpoint E-18) — client-triggered force-flush of
// the calling specialist's pending offline-queue items (F-14 Offline
// Tolerance, BR-68). The companion WRITE-side endpoint to the P3C-05
// `GET /queue/pending` (E-17). The SPA's queue indicator's "Force sync" tap
// (P3C-12) calls this after a reconnect.
//
// Scope (P3C-06): endpoint SHELL. The per-item flush mechanics — Review
// Required state machine (P3C-08), retry budget (P3C-09), and per-item
// enqueue-time idempotency keys (P3C-10) — are not yet built, so this handler
// gates the request through the canonical composition, writes the
// `queue.force_sync_triggered` envelope audit row PRE-response, and returns
// the §7.5.2 wire shape with counts derived from the existing read repo.
// Per-item replays and per-item audit rows arrive with P3C-08/09/10; the
// `itemsCompleted` / `itemsRouterToReview` fields stay `0` until then.
//
// Auth: `withSession` (P1A-04) gates entry. Per API §8.3.2 L1995 the endpoint
// is SPECIALIST-only; supervisor, VP, system_admin all 403. The per-specialist
// data scope is the repository query predicate (server-resolved
// `ctx.specialistId`, never a body field) so cross-specialist replay is
// structurally impossible.
//
// Idempotency: `withIdempotency` (Pattern D / TR-WRITE-2) requires a UUIDv4
// `Idempotency-Key` header per Immutable #6. Duplicates inside the 24h window
// replay the cached body and skip the handler — so exactly one audit row is
// written per accepted request.
//
// Rate limit: 1 per 2s per specialist (API §6 L371 anti-thrash). Uses the
// existing `RateLimiter.checkAndConsume` seam — same shape as `auth/refresh`.
// A 429 is NOT audited here (mirrors the in-flight idempotency / origin-CSRF
// posture: a rejected request is not a state mutation; correlation lives on
// the structured log via trace_id). The auth/refresh handler audits 429s as
// auth events (SEC-AUDIT-7) — that scope is auth-specific and not the
// queue-flush convention.
//
// Audit: one `queue.force_sync_triggered` row, `outcome = "SUCCESS"`, written
// PRE-response (Immutable #5 / Pattern B). No `participantId`, no payload
// content — `payload_metadata` carries only the four §7.5.2 counters +
// `source: "tool"` so the no-PII assertion passes. Audit failure surfaces as
// a 500 via the outer catch — never silent.
//
// All logic lives here so it is unit-testable without a Next runtime;
// `apps/web` carries only a thin route shim.

import { writeAuditEntry } from "@anthos/audit";
import { createLogger, resolveTraceId } from "@anthos/logging";
import type { StructuredLogger } from "@anthos/logging";
import type { DbOrTx, PendingQueueResult } from "@anthos/persistence";
import type { SessionConfig } from "@anthos/auth";

import { withIdempotency } from "../idempotency/middleware.js";
import type {
  IdempotentHandler,
  IdempotentRequestContext,
  WithIdempotencyOptions,
} from "../idempotency/middleware.js";
import type { IdempotencyStore } from "../idempotency/store.js";
import { rateLimitErrorResponse } from "../ratelimit/responses.js";
import type { RateLimiter } from "../ratelimit/store.js";
import { withSession } from "../session/middleware.js";
import type {
  SessionHandler,
  SessionRequestContext,
  WithSessionOptions,
} from "../session/middleware.js";
import type { SessionStore } from "../session/store.js";

import { buildQueueSyncBody } from "./dto.js";
import {
  internalErrorResponse,
  queueSyncSuccessResponse,
  roleInsufficientScopeResponse,
} from "./responses.js";

const defaultLogger = createLogger({ module: "api.queue.sync" });

// Rate-limit scope + window (API §6 L371: "1 per 2s per specialist
// (anti-thrash)"). The key shape `queue.sync:<specialistId>` mirrors the
// auth/refresh `auth.refresh:<id>` convention so the `rate_limits` table can
// be inspected by-scope when investigating anti-thrash hits.
const RATE_LIMIT_SCOPE = "queue.sync";
const RATE_LIMIT_WINDOW_SECONDS = 2;
const RATE_LIMIT_BUDGET = 1;

type GetPending = (
  db: DbOrTx,
  specialistId: string,
) => Promise<PendingQueueResult>;

export interface QueueSyncHandlerOptions {
  // withSession seams — defaults resolve inside withSession.
  readonly store?: SessionStore;
  readonly sessionConfig?: SessionConfig;
  readonly logger?: StructuredLogger;
  // withIdempotency seam.
  readonly idempotencyStore?: IdempotencyStore;
  // Rate-limit seam — defaults to the lazily-resolved Postgres limiter.
  readonly rateLimiter?: RateLimiter;
  // Persistence + audit seams.
  readonly db?: DbOrTx;
  readonly writeAudit?: typeof writeAuditEntry;
  readonly getPendingImpl?: GetPending;
  // Server-clock seam — resolved once per request so the audit row +
  // `syncTriggeredAt` are stamped against an identical instant.
  readonly now?: () => Date;
}

export async function handleQueueSync(
  req: Request,
  options: QueueSyncHandlerOptions = {},
): Promise<Response> {
  const traceId = resolveTraceId(req);
  const log = (options.logger ?? defaultLogger).child({ traceId });

  // Compose withSession → withIdempotency → core. Same pattern as
  // `barriers/create-barrier.ts`: session is resolved first so the idempotency
  // lock is bound to the authenticated specialist (cross-specialist isolation
  // is enforced inside the middleware), and the inner core sees a merged
  // context typed as `SessionRequestContext & IdempotentRequestContext`.
  const idemOptions: WithIdempotencyOptions = {
    ...(options.idempotencyStore !== undefined
      ? { store: options.idempotencyStore }
      : {}),
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
  };

  const sessionCore: SessionHandler = (sessionReq, sessionCtx) => {
    const inner: IdempotentHandler = (idemReq, idemCtx) =>
      runQueueSync(idemReq, { ...sessionCtx, ...idemCtx }, options, log);
    return withIdempotency(inner, idemOptions)(sessionReq, sessionCtx);
  };

  const sessionOptions: WithSessionOptions = {
    ...(options.store !== undefined ? { store: options.store } : {}),
    ...(options.sessionConfig !== undefined
      ? { config: options.sessionConfig }
      : {}),
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
  };

  try {
    return await withSession(sessionCore, sessionOptions)(req);
  } catch (err) {
    // No silent catch. withSession's own 401s return directly;
    // reaching here is an unexpected fault — a 500, never a 401.
    log.error("queue sync request failed unexpectedly", {
      event: "queue_sync_internal_error",
      reason: errorReason(err),
    });
    return internalErrorResponse(traceId);
  }
}

async function runQueueSync(
  _req: Request,
  ctx: SessionRequestContext & IdempotentRequestContext,
  options: QueueSyncHandlerOptions,
  log: StructuredLogger,
): Promise<Response> {
  // Role gate — API §8.3.2 L1995 gives SPECIALIST `✓` and SUPERVISOR / VP /
  // SYSTEM_ADMIN all `✗`. Same posture as `GET /queue/pending`. The handler
  // owns the gate; route shim does no role check.
  if (ctx.role !== "SPECIALIST") {
    return roleInsufficientScopeResponse(ctx.traceId, "role_not_permitted");
  }

  // Rate limit (API §6 L371: 1 per 2s per specialist, anti-thrash). A 429 is
  // not audited — the rejected request mutates nothing; structured-log
  // correlation suffices.
  const rateLimiter = await resolveRateLimiter(options.rateLimiter);
  const limit = await rateLimiter.checkAndConsume(
    `${RATE_LIMIT_SCOPE}:${ctx.specialistId}`,
    RATE_LIMIT_WINDOW_SECONDS,
  );
  if (!limit.allowed) {
    log.warn("queue sync rate limit exceeded", {
      event: "queue_sync_rate_limited",
    });
    return rateLimitErrorResponse(ctx.traceId, {
      retryAfterSeconds: limit.retryAfterSeconds ?? RATE_LIMIT_WINDOW_SECONDS,
      limit: RATE_LIMIT_BUDGET,
    });
  }

  // Read pending items via the existing P3C-04/05 repo. The shell handler
  // does not mutate any row; the counts feed the §7.5.2 response envelope.
  //
  // TODO(P3C-06 flush loop / P3C-09 / P3C-10): replace this read with the
  // per-item flush loop. Iterate `pending_sync` rows; per item, call
  // `applyTransition(status, { kind: "attempt_start" })` (TR-OFFLINE-5a state
  // machine, `packages/domain/src/offline-queue/`), dispatch via the SF
  // mutation adapter, then call `applyTransition` again with one of
  // `attempt_succeeded` / `attempt_failed_transient` /
  // `attempt_failed_lock_row` / `attempt_failed_semantic`. Retry budget
  // (P3C-09) feeds `retryBudgetExhausted`. Each attempt writes its own audit
  // row PRE-response; this envelope row stays.
  const { db, getPending } = await resolvePersistence(options);
  let result: PendingQueueResult;
  try {
    result = await getPending(db, ctx.specialistId);
  } catch (err) {
    log.error("queue sync repository read failed", {
      event: "queue_sync_repository_error",
      reason: errorReason(err),
    });
    return internalErrorResponse(ctx.traceId);
  }

  const now = (options.now ?? (() => new Date()))();
  const body = buildQueueSyncBody({ result, now });

  // Audit PRE-response (Immutable #5 / Pattern B). A throw here propagates
  // to the outer 500 — the mandatory-audit gate is not allowed to fail
  // silently. No PII in metadata: only the four §7.5.2 counters + source.
  //
  // [SPEC INCONSISTENCY — flag for the next API amendment]
  // The action_type `queue.force_sync_triggered` is the authoritative value
  // for E-18 per API §6 row 371 (the endpoint matrix). It is NOT enumerated
  // in the §11.6 canonical action_type catalog, which closes with
  // `notification_pref.updated`. The §6 row
  // wins for this endpoint; the catalog needs a forward amendment to add
  // `queue.force_sync_triggered`. Surfacing in code so the next maintainer
  // / next spec pass catches it.
  const writeAudit = options.writeAudit ?? writeAuditEntry;
  await writeAudit(db, {
    specialistId: ctx.specialistId,
    actionType: "queue.force_sync_triggered",
    outcome: "SUCCESS",
    channel: "system",
    traceId: ctx.traceId,
    payloadMetadata: {
      items_attempted: body.itemsAttempted,
      items_completed: body.itemsCompleted,
      // Mirrors the §7.5.2 wire-key spelling (`itemsRouterToReview`) on the
      // metadata side too, so audit-log inspectors can join the two without
      // remapping. The spec typo is preserved verbatim (don't auto-correct spec terms).
      items_router_to_review: body.itemsRouterToReview,
      items_remaining: body.itemsRemaining,
      source: "tool",
    },
  });

  return queueSyncSuccessResponse(body, ctx.traceId);
}

// Lazily-resolved, memoized default rate limiter. Same pattern as
// `auth/refresh.ts:137-148`. Tests inject the seam so this DB-backed path is
// never reached.
let defaultRateLimiterPromise: Promise<RateLimiter> | undefined;
async function resolveRateLimiter(
  injected: RateLimiter | undefined,
): Promise<RateLimiter> {
  if (injected !== undefined) return injected;
  defaultRateLimiterPromise ??= import("../ratelimit/postgres-store.js").then(
    (m) => m.createDefaultPostgresRateLimiter(),
  );
  return defaultRateLimiterPromise;
}

// Resolves the DB + repository seams. Mirrors `get-queue-pending.ts`: defaults
// dynamic-import `@anthos/persistence` so the DB connection side effect stays
// out of the static import graph. Tests inject both so the default is never
// hit.
async function resolvePersistence(
  options: QueueSyncHandlerOptions,
): Promise<{ db: DbOrTx; getPending: GetPending }> {
  if (options.db !== undefined && options.getPendingImpl !== undefined) {
    return { db: options.db, getPending: options.getPendingImpl };
  }
  const persistence = await import("@anthos/persistence");
  return {
    db: options.db ?? persistence.db,
    getPending:
      options.getPendingImpl ??
      ((dbArg, specialistId) =>
        persistence.repositories.getPendingForSpecialist(dbArg, specialistId)),
  };
}

function errorReason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
