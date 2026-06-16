// GET /api/v1/queue/pending (endpoint E-17) — the caller's pending offline
// queue items (F-14 Offline Tolerance). The SPA consumes this for the
// persistent queue UI indicator (P3C-12, reads `queueDepth`) and the Review
// Required surface (P3C-07, reads `items[]` + `errorDetails` +
// `suggestedResolution`).
//
// Auth: `withSession` (P1A-04) owns the gate — the core runs only for a live
// session. Per API §8.3.2 L1994 the endpoint is SPECIALIST-only; supervisor,
// VP, and system_admin all 403. The per-specialist data scope is the
// repository query predicate (server-resolved `ctx.specialistId`, never a
// query param) so cross-specialist access is structurally impossible.
//
// Audit: NO audit row. Read-only endpoint — Immutable #5 governs state
// mutations, not reads (same posture as the warm-cache caseload GET).
//
// All logic lives here so it is unit-testable without a Next runtime;
// `apps/web` carries only a thin route shim.

import { createLogger, resolveTraceId } from "@anthos/logging";
import type { StructuredLogger } from "@anthos/logging";
import type { DbOrTx, PendingQueueResult } from "@anthos/persistence";
import type { SessionConfig } from "@anthos/auth";

import { withSession } from "../session/middleware.js";
import type {
  SessionHandler,
  SessionRequestContext,
  WithSessionOptions,
} from "../session/middleware.js";
import type { SessionStore } from "../session/store.js";
import { buildQueuePendingBody } from "./dto.js";
import {
  internalErrorResponse,
  queuePendingSuccessResponse,
  roleInsufficientScopeResponse,
} from "./responses.js";

const defaultLogger = createLogger({ module: "api.queue" });

type GetPending = (
  db: DbOrTx,
  specialistId: string,
) => Promise<PendingQueueResult>;

export interface QueuePendingHandlerOptions {
  // withSession seams — defaults resolve inside withSession.
  readonly store?: SessionStore;
  readonly sessionConfig?: SessionConfig;
  readonly logger?: StructuredLogger;
  // Test seams — default to the live repository + DB.
  readonly db?: DbOrTx;
  readonly getPendingImpl?: GetPending;
}

export async function handleQueuePending(
  req: Request,
  options: QueuePendingHandlerOptions = {},
): Promise<Response> {
  const traceId = resolveTraceId(req);
  const log = (options.logger ?? defaultLogger).child({ traceId });

  const core: SessionHandler = (sessionReq, ctx) =>
    runQueuePending(sessionReq, ctx, options, log);

  // exactOptionalPropertyTypes forbids explicit `undefined` — spread each
  // injected seam only when supplied (mirrors handleCaseload / handleMe).
  const sessionOptions: WithSessionOptions = {
    ...(options.store !== undefined ? { store: options.store } : {}),
    ...(options.sessionConfig !== undefined
      ? { config: options.sessionConfig }
      : {}),
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
  };

  try {
    return await withSession(core, sessionOptions)(req);
  } catch (err) {
    // No silent catch. withSession's own 401s return directly;
    // reaching here is an unexpected fault — a 500, never a 401.
    log.error("queue pending request failed unexpectedly", {
      event: "queue_pending_internal_error",
      reason: errorReason(err),
    });
    return internalErrorResponse(traceId);
  }
}

async function runQueuePending(
  _req: Request,
  ctx: SessionRequestContext,
  options: QueuePendingHandlerOptions,
  log: StructuredLogger,
): Promise<Response> {
  // Role gate — API §8.3.2 L1994 gives SPECIALIST `✓` and SUPERVISOR / VP /
  // SYSTEM_ADMIN all `✗` (permanent, not the "supervisor scope unmapped"
  // stub posture the participant-detail handler uses). Every non-specialist
  // is `role_not_permitted`.
  if (ctx.role !== "SPECIALIST") {
    return roleInsufficientScopeResponse(ctx.traceId, "role_not_permitted");
  }

  const { db, getPending } = await resolvePersistence(options);

  let result: PendingQueueResult;
  try {
    result = await getPending(db, ctx.specialistId);
  } catch (err) {
    log.error("queue pending repository read failed", {
      event: "queue_pending_repository_error",
      reason: errorReason(err),
    });
    return internalErrorResponse(ctx.traceId);
  }

  const body = buildQueuePendingBody({
    specialistId: ctx.specialistId,
    result,
  });
  return queuePendingSuccessResponse(body, ctx.traceId);
}

// Resolves the DB + repository seams. Defaults dynamic-import `@anthos/persistence`
// so the DB connection side effect stays out of @anthos/api's static import
// graph (mirrors handleCaseload). Tests inject both so this is never reached.
async function resolvePersistence(
  options: QueuePendingHandlerOptions,
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
