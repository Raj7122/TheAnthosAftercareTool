// POST /api/v1/queue/:id/resolve (endpoint E-19) — specialist disposes of an
// `offline_queue` row that landed in the Review Required state machine
// (F-14 Offline Tolerance, TR-OFFLINE-5a, Pattern E). Three resolutions per
// Pattern E line 36-50: `DISCARD` (remove + audit reason); `REASSIGN_RETRY`
// (rewrite payload owner, reset retry budget, push back to `pending_sync`);
// `ESCALATE_TO_SUPERVISOR` (remove + emit `escalation.created` audit row for
// F-17 supervisor surface). EC-46 reverted-reassignment auto-resolution is
// explicitly out — every resolution is specialist-initiated
// (`resolution_source='specialist'`).
//
// SPEC NUMBERING — both the ticket title and impl-plan §3 row 463 cite
// E-20 for this endpoint, but API_v1_3.md §7.5 row 372 + §7.5.3 carry it as
// E-19 (E-20 is `GET /supervisor/dashboard`). Spec precedence ranks
// API_v1_3.md above the impl plan, so this file uses E-19 throughout. The
// ticket title + impl-plan row need an amendment at archive time — same
// posture P3C-06 used for the `itemsRouterToReview` spec typo.
//
// Scope (P3C-07): the endpoint SHELL. Two pieces are stubbed against the
// state of the codebase:
//   - `supervisor_escalations` table doesn't exist yet (P4-01 in impl plan §3
//     row 524 creates it in Phase 4). ESCALATE_TO_SUPERVISOR generates the
//     `escalationId` locally and writes the `escalation.created` audit row
//     with it; the INSERT lands when the schema does. `supervisorNotified`
//     stays `true` on the wire so the SPA's bind point doesn't shift.
//   - REASSIGN_RETRY's "immediate flush attempt result" per §7.5.3 row 1311
//     requires the per-item flush mechanics from P3C-08/09; until those land
//     this handler resets the row to `pending_sync` (correct per spec) and
//     omits the `flushResult` field — same shell posture as P3C-06.
//
// Auth: `withSession` (P1A-04) gates entry. Per API §8.3.2 row 1996 the
// endpoint is SPECIALIST-only; supervisor, VP, system_admin all 403. The
// per-item ownership check (`item.specialistId !== ctx.specialistId`) +
// missing-row check both collapse into one 404 so a specialist cannot infer
// the existence of another's queue rows by probing ids.
//
// Idempotency: `withIdempotency` (Pattern D / TR-WRITE-2) requires a UUIDv4
// `Idempotency-Key` per Immutable #6. Duplicates inside the 24h window replay
// the cached body and skip the handler — exactly one update + audit pair per
// accepted request.
//
// Audit: TWO Pattern B rows per accepted resolve, both written PRE-response
// (Immutable #5):
//   1. `offline.action.resolved` — the umbrella row per the API §6 row 372
//      action_type vocabulary, with `payload_metadata.action` carrying the
//      specific disposition.
//   2. One per-action row matching the same row 372 sub-action enumeration
//      (`offline.action.discarded` / `offline.action.reassign_retried` /
//      `escalation.created`).
// Pattern E line 38/45/50 names the rows `REVIEW_RESOLVED` with outcome
// `DISCARDED`/`REASSIGNED`/`ESCALATED`, but the `audit_log.outcome` CHECK
// constraint only admits `SUCCESS`/`FAILED`/`QUEUED` — so the spec contract
// in API §6 row 372 wins and Pattern E carries a forward divergence to be
// reconciled in the next spec pass. Same posture P3C-06 used for
// `queue.force_sync_triggered`.
//
// All logic lives here so it is unit-testable without a Next runtime;
// `apps/web` carries only a thin route shim.

import { randomUUID } from "node:crypto";

import { writeAuditEntry } from "@anthos/audit";
import {
  applyTransition,
  InvalidTransitionError,
  type TransitionResult,
} from "@anthos/domain";
import { assertSalesforceId } from "@anthos/integrations";
import { createLogger, resolveTraceId } from "@anthos/logging";
import type { StructuredLogger } from "@anthos/logging";
import type {
  ApplyQueueResolutionInput,
  DbOrTx,
  OfflineQueueRow,
  OfflineQueueStatus,
} from "@anthos/persistence";
import type { SessionConfig } from "@anthos/auth";

import { withIdempotency } from "../idempotency/middleware.js";
import type {
  IdempotentHandler,
  IdempotentRequestContext,
  WithIdempotencyOptions,
} from "../idempotency/middleware.js";
import type { IdempotencyStore } from "../idempotency/store.js";
import { withSession } from "../session/middleware.js";
import type {
  SessionHandler,
  SessionRequestContext,
  WithSessionOptions,
} from "../session/middleware.js";
import type { SessionStore } from "../session/store.js";

import {
  queueResolveRequestSchema,
  type QueueResolveEscalationBody,
  type QueueResolveRequest,
  type QueueResolveSuccessBody,
} from "./dto.js";
import {
  internalErrorResponse,
  queueItemNotFoundResponse,
  queueItemNotResolvableResponse,
  queueResolveSuccessResponse,
  queueResolveValidationErrorResponse,
  roleInsufficientScopeResponse,
} from "./responses.js";

const defaultLogger = createLogger({ module: "api.queue.resolve" });

// The two Review Required variants Pattern E line 30/31 produces. Only items
// in one of these states are eligible for the three specialist resolutions.
const RESOLVABLE_STATUSES: ReadonlySet<OfflineQueueStatus> = new Set([
  "review_required_reassigned",
  "review_required_terminated",
]);

type FindQueueItemById = (
  db: DbOrTx,
  id: string,
) => Promise<OfflineQueueRow | null>;

type ApplyQueueResolution = (
  db: DbOrTx,
  input: ApplyQueueResolutionInput,
) => Promise<number>;

export interface QueueResolveHandlerOptions {
  // withSession seams — defaults resolve inside withSession.
  readonly store?: SessionStore;
  readonly sessionConfig?: SessionConfig;
  readonly logger?: StructuredLogger;
  // withIdempotency seam.
  readonly idempotencyStore?: IdempotencyStore;
  // Persistence + audit seams.
  readonly db?: DbOrTx;
  readonly writeAudit?: typeof writeAuditEntry;
  readonly findQueueItemByIdImpl?: FindQueueItemById;
  readonly applyQueueResolutionImpl?: ApplyQueueResolution;
  // Server-clock seam — resolved once per request so the audit rows + the
  // `resolvedAt` wire field stamp against an identical instant.
  readonly now?: () => Date;
  // Escalation id seam — defaults to `randomUUID()`. Tests inject so the
  // wire/audit value is asserted deterministically.
  readonly newEscalationId?: () => string;
}

export type QueueResolveRouteContext = {
  readonly params: Promise<{ id: string }> | { id: string };
};

export async function handleQueueResolve(
  req: Request,
  routeCtx: QueueResolveRouteContext,
  options: QueueResolveHandlerOptions = {},
): Promise<Response> {
  const traceId = resolveTraceId(req);
  const log = (options.logger ?? defaultLogger).child({ traceId });

  let queueItemId: string;
  try {
    const params = await Promise.resolve(routeCtx.params);
    queueItemId = params.id;
  } catch (err) {
    log.error("queue resolve route params resolution failed", {
      event: "queue_resolve_params_error",
      reason: errorReason(err),
    });
    return internalErrorResponse(traceId);
  }

  // Compose withSession → withIdempotency → core. Same wrapping shape as
  // handleQueueSync / handleCloseBarrier — session resolves first so the
  // idempotency lock is bound to the authenticated specialist (cross-
  // specialist isolation enforced inside withIdempotency), and the inner
  // core sees a merged `SessionRequestContext & IdempotentRequestContext`.
  const idemOptions: WithIdempotencyOptions = {
    ...(options.idempotencyStore !== undefined
      ? { store: options.idempotencyStore }
      : {}),
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
  };

  const sessionCore: SessionHandler = (sessionReq, sessionCtx) => {
    const inner: IdempotentHandler = (idemReq, idemCtx) =>
      runQueueResolve(
        idemReq,
        { ...sessionCtx, ...idemCtx },
        queueItemId,
        options,
        log,
      );
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
    log.error("queue resolve request failed unexpectedly", {
      event: "queue_resolve_internal_error",
      reason: errorReason(err),
    });
    return internalErrorResponse(traceId);
  }
}

async function runQueueResolve(
  req: Request,
  ctx: SessionRequestContext & IdempotentRequestContext,
  queueItemId: string,
  options: QueueResolveHandlerOptions,
  log: StructuredLogger,
): Promise<Response> {
  // Role gate — API §8.3.2 row 1996 gives SPECIALIST `✓` and SUPERVISOR / VP
  // / SYSTEM_ADMIN all `✗`. Same posture as the sibling /queue/pending +
  // /queue/sync handlers. The handler owns the gate; route shim does no
  // role check.
  if (ctx.role !== "SPECIALIST") {
    return roleInsufficientScopeResponse(ctx.traceId, "role_not_permitted");
  }

  // Parse + validate the JSON body. An unparseable body is a 400 (the
  // client sent something we cannot interpret), matching the close-barrier
  // precedent for validation rejections — the §7.5.3 contract is "strict
  // shape, action enum + conditional newOwnerId + capped notes".
  let bodyJson: unknown;
  try {
    const text = await req.text();
    bodyJson = text.length === 0 ? {} : JSON.parse(text);
  } catch {
    return queueResolveValidationErrorResponse(ctx.traceId, {
      field: "body",
      reason: "invalid_json",
    });
  }

  const parseResult = queueResolveRequestSchema.safeParse(bodyJson);
  if (!parseResult.success) {
    const first = parseResult.error.issues[0];
    const field = first?.path.join(".") || "body";
    return queueResolveValidationErrorResponse(ctx.traceId, {
      field,
      reason: first?.message ?? "validation_failed",
    });
  }
  const validated: QueueResolveRequest = parseResult.data;

  // Salesforce-id shape check on `newOwnerId` (15/18 alphanumeric). Fail
  // fast here so a malformed id surfaces as a 400 VALIDATION_FAILED rather
  // than deferring to the next flush attempt, where it would land as a SF
  // 4xx that loops the row back into Review Required. Mirrors the
  // create-barrier / close-barrier validation precedent.
  if (validated.action === "REASSIGN_RETRY") {
    try {
      assertSalesforceId(validated.newOwnerId ?? "", "newOwnerId");
    } catch {
      return queueResolveValidationErrorResponse(ctx.traceId, {
        field: "newOwnerId",
        reason: "invalid_salesforce_id",
      });
    }
  }

  // Per-specialist ownership check. Missing + cross-specialist BOTH collapse
  // into a single 404 (PII firewall: don't reveal the existence of another
  // specialist's queue rows). The repository is the source of truth — the
  // route param `id` is the only client-supplied value involved and it is a
  // UUIDv4 (validated by Pattern D's URL→hash binding via the Idempotency
  // middleware request-hash, plus by the DB layer which would reject any
  // non-UUID id with a typed error).
  const { db, findQueueItemByIdFn, applyQueueResolutionFn } =
    await resolvePersistence(options);

  let item: OfflineQueueRow | null;
  try {
    item = await findQueueItemByIdFn(db, queueItemId);
  } catch (err) {
    log.error("queue resolve repository read failed", {
      event: "queue_resolve_read_error",
      reason: errorReason(err),
    });
    return internalErrorResponse(ctx.traceId);
  }
  if (item === null || item.specialistId !== ctx.specialistId) {
    return queueItemNotFoundResponse(ctx.traceId);
  }

  // Resolvable-state gate — Pattern E line 34 names the two source states;
  // every other status is non-resolvable through this endpoint.
  if (!RESOLVABLE_STATUSES.has(item.status)) {
    return queueItemNotResolvableResponse(ctx.traceId, item.status);
  }

  // Shared resolution metadata. `now` resolves once so the wire payload, the
  // UPDATE timestamp, and both audit rows stamp against an identical instant.
  const now = (options.now ?? (() => new Date()))();
  const writeAudit = options.writeAudit ?? writeAuditEntry;

  switch (validated.action) {
    case "DISCARD":
      return resolveDiscard({
        ctx,
        item,
        validated,
        applyQueueResolutionFn,
        db,
        writeAudit,
        log,
        now,
      });
    case "REASSIGN_RETRY":
      return resolveReassignRetry({
        ctx,
        item,
        validated,
        applyQueueResolutionFn,
        db,
        writeAudit,
        log,
        now,
      });
    case "ESCALATE_TO_SUPERVISOR":
      return resolveEscalate({
        ctx,
        item,
        validated,
        applyQueueResolutionFn,
        db,
        writeAudit,
        log,
        now,
        newEscalationId: options.newEscalationId ?? randomUUID,
      });
  }
}

interface ResolveContext {
  readonly ctx: SessionRequestContext & IdempotentRequestContext;
  readonly item: OfflineQueueRow;
  readonly validated: QueueResolveRequest;
  readonly applyQueueResolutionFn: ApplyQueueResolution;
  readonly db: DbOrTx;
  readonly writeAudit: typeof writeAuditEntry;
  readonly log: StructuredLogger;
  readonly now: Date;
}

async function resolveDiscard(args: ResolveContext): Promise<Response> {
  const { ctx, item, validated, applyQueueResolutionFn, db, writeAudit, log, now } =
    args;
  const transition = applyTransition(item.status, {
    kind: "resolve",
    action: "DISCARD",
  });

  const updated = await safeApply(
    applyQueueResolutionFn,
    db,
    buildResolutionInput(item, validated, transition, now, ctx.specialistId),
    log,
  );
  if (updated === "error") return internalErrorResponse(ctx.traceId);
  if (updated === 0) return queueItemNotResolvableResponse(ctx.traceId, item.status);

  await writeResolveAuditPair({
    writeAudit,
    db,
    ctx,
    item,
    validated,
    actionType: "offline.action.discarded",
    extraMetadata: {},
  });

  const body: QueueResolveSuccessBody = {
    queueItemId: item.id,
    status: transition.nextStatus,
    resolvedAt: now.toISOString(),
    resolvedBy: ctx.specialistId,
    // Every `resolve` event surfaces `specialist` (the state machine pins it);
    // the DTO mirrors that wire constraint. `transition.resolutionSource`
    // would type-widen to the full ResolutionSource union, so we pass the
    // literal and rely on the parity test to keep the two in lockstep.
    resolutionSource: "specialist",
  };
  return queueResolveSuccessResponse(body, ctx.traceId, 200);
}

async function resolveReassignRetry(args: ResolveContext): Promise<Response> {
  const { ctx, item, validated, applyQueueResolutionFn, db, writeAudit, log, now } =
    args;
  // EC-46 manual-only stance (Pattern E line 69): a reverted reassignment does
  // NOT auto-clear the row. The specialist's REASSIGN_RETRY tap is the only
  // exit from `review_required_reassigned`; the state machine has no
  // CDC-event input to auto-resolve. The Zod + `assertSalesforceId` checks
  // above already guaranteed `validated.newOwnerId` is a Salesforce id, so
  // the state machine's missing-owner guard is a defense-in-depth — a typed
  // throw here would be a programmer bug, never a 400.
  let transition: TransitionResult;
  try {
    // `validated.newOwnerId` is Zod-required for REASSIGN_RETRY (dto.ts:172)
    // and confirmed Salesforce-shaped by `assertSalesforceId` above, but its
    // static type is `string | undefined`. `exactOptionalPropertyTypes`
    // rejects passing `undefined` to an optional `string`, so coerce via
    // empty-string fallback — the state machine then re-validates and the
    // dual guard surfaces any wire-validation gap as a typed error rather
    // than a silent null write.
    transition = applyTransition(item.status, {
      kind: "resolve",
      action: "REASSIGN_RETRY",
      newOwnerId: validated.newOwnerId ?? "",
    });
  } catch (err) {
    log.error("queue resolve transition rejected REASSIGN_RETRY", {
      event: "queue_resolve_transition_error",
      reason: errorReason(err),
      code:
        err instanceof InvalidTransitionError ? err.code : "unknown_transition_error",
    });
    return internalErrorResponse(ctx.traceId);
  }

  const updated = await safeApply(
    applyQueueResolutionFn,
    db,
    buildResolutionInput(item, validated, transition, now, ctx.specialistId),
    log,
  );
  if (updated === "error") return internalErrorResponse(ctx.traceId);
  if (updated === 0) return queueItemNotResolvableResponse(ctx.traceId, item.status);

  await writeResolveAuditPair({
    writeAudit,
    db,
    ctx,
    item,
    validated,
    actionType: "offline.action.reassign_retried",
    extraMetadata: {},
  });

  // TODO(P3C-06 flush loop): once the per-item flush mechanics land, perform
  // the immediate flush attempt per §7.5.3 row 1311 (call applyTransition
  // again with `attempt_start` → SF call → branch on result) and include the
  // result on the wire.
  const body: QueueResolveSuccessBody = {
    queueItemId: item.id,
    status: transition.nextStatus,
    resolvedAt: now.toISOString(),
    resolvedBy: ctx.specialistId,
    resolutionSource: "specialist",
  };
  return queueResolveSuccessResponse(body, ctx.traceId, 200);
}

interface EscalateContext extends ResolveContext {
  readonly newEscalationId: () => string;
}

async function resolveEscalate(args: EscalateContext): Promise<Response> {
  const {
    ctx,
    item,
    validated,
    applyQueueResolutionFn,
    db,
    writeAudit,
    log,
    now,
    newEscalationId,
  } = args;
  const escalationId = newEscalationId();
  const transition = applyTransition(item.status, {
    kind: "resolve",
    action: "ESCALATE_TO_SUPERVISOR",
  });
  // The state machine flags `emitsEscalation` to remind the caller that an
  // INSERT into `supervisor_escalations` is owed. Today the audit row carries
  // the escalation_id; the table INSERT lands with P4-01.
  const updated = await safeApply(
    applyQueueResolutionFn,
    db,
    buildResolutionInput(item, validated, transition, now, ctx.specialistId),
    log,
  );
  if (updated === "error") return internalErrorResponse(ctx.traceId);
  if (updated === 0) return queueItemNotResolvableResponse(ctx.traceId, item.status);

  await writeResolveAuditPair({
    writeAudit,
    db,
    ctx,
    item,
    validated,
    actionType: "escalation.created",
    extraMetadata: { escalation_id: escalationId },
  });

  // TODO(P4-01): INSERT into `supervisor_escalations` once that table lands
  // (provisioned by impl plan §3 row 524, signaled here by
  // `transition.emitsEscalation`). The audit row above already carries the
  // escalation_id so cross-table reconciliation by id works once the INSERT
  // is wired.
  const body: QueueResolveEscalationBody = {
    queueItemId: item.id,
    escalationId,
    status: transition.nextStatus,
    resolvedAt: now.toISOString(),
    resolvedBy: ctx.specialistId,
    resolutionSource: "specialist",
    supervisorNotified: true,
  };
  return queueResolveSuccessResponse(body, ctx.traceId, 201);
}

// Writes the two-row audit pair per the API §6 row 372 vocabulary — one
// umbrella `offline.action.resolved` row carrying the disposition, plus one
// per-action row. Both pre-response per Immutable #5; an audit failure
// propagates and is converted to a 500 by the outer try/catch in
// `handleQueueResolve`.
//
// PII firewall: `payload_metadata` carries only the wire-level identifiers
// — the action enum, the queue item UUID, the participant ID echo (the same
// SF id the queue row already stores), the original `action_type` (the kind
// of mutation that was queued, e.g. `participants.call.logged`), the
// escalation id when set, and the optional `notes` string. `notes` is
// specialist-authored rationale capped at 1000 chars; participant content
// (names, contact info) is rejected by `assertNoPii` regardless of key.
async function writeResolveAuditPair(args: {
  writeAudit: typeof writeAuditEntry;
  db: DbOrTx;
  ctx: SessionRequestContext & IdempotentRequestContext;
  item: OfflineQueueRow;
  validated: QueueResolveRequest;
  actionType:
    | "offline.action.discarded"
    | "offline.action.reassign_retried"
    | "escalation.created";
  extraMetadata: Record<string, unknown>;
}): Promise<void> {
  const { writeAudit, db, ctx, item, validated, actionType, extraMetadata } =
    args;
  const sharedMetadata: Record<string, unknown> = {
    action: validated.action,
    queue_item_id: item.id,
    queued_action_type: item.actionType,
    ...(validated.notes !== undefined ? { notes: validated.notes } : {}),
    ...extraMetadata,
  };

  await writeAudit(db, {
    specialistId: ctx.specialistId,
    ...(item.participantId !== null
      ? { participantId: item.participantId }
      : {}),
    actionType: "offline.action.resolved",
    outcome: "SUCCESS",
    channel: "system",
    traceId: ctx.traceId,
    payloadMetadata: sharedMetadata,
  });

  await writeAudit(db, {
    specialistId: ctx.specialistId,
    ...(item.participantId !== null
      ? { participantId: item.participantId }
      : {}),
    actionType,
    outcome: "SUCCESS",
    channel: "system",
    traceId: ctx.traceId,
    payloadMetadata: sharedMetadata,
  });
}

// Translates a TransitionResult from the state machine (TR-OFFLINE-5a /
// Pattern E) into the persistence-layer column update. The state machine owns
// "what fields move and to what values"; this function owns "how those
// decisions map onto `ApplyQueueResolutionInput`". `resolutionAction` is
// asserted non-null here because every `resolve` event sets it — the call
// sites in this file only invoke this helper after `applyTransition` with a
// `{ kind: "resolve", … }` event.
function buildResolutionInput(
  item: OfflineQueueRow,
  validated: QueueResolveRequest,
  transition: TransitionResult,
  now: Date,
  specialistId: string,
): ApplyQueueResolutionInput {
  if (transition.resolutionAction === null) {
    // Unreachable in practice — caller only passes `resolve` transitions.
    throw new Error(
      "internal: buildResolutionInput called with a non-resolve transition",
    );
  }
  const base: ApplyQueueResolutionInput = {
    id: item.id,
    status: transition.nextStatus,
    resolutionAction: transition.resolutionAction,
    resolutionSource: transition.resolutionSource,
    resolvedAt: now,
    resolvedBy: specialistId,
    resolutionNotes: validated.notes ?? null,
  };
  const withRetry: ApplyQueueResolutionInput =
    transition.retryCount === "reset" ? { ...base, retryCount: 0 } : base;
  if (transition.payloadMutation === null) return withRetry;
  return {
    ...withRetry,
    payload: mergePayload(item.payload, transition.payloadMutation),
  };
}

// Returns the updated row count, or the sentinel `"error"` if the UPDATE
// threw. A `0` result means another writer beat us to the resolution — the
// handler converts that to a 409 (the row's status is no longer one of the
// resolvable Review Required variants).
async function safeApply(
  applyFn: ApplyQueueResolution,
  db: DbOrTx,
  input: ApplyQueueResolutionInput,
  log: StructuredLogger,
): Promise<number | "error"> {
  try {
    return await applyFn(db, input);
  } catch (err) {
    log.error("queue resolve repository write failed", {
      event: "queue_resolve_write_error",
      reason: errorReason(err),
    });
    return "error";
  }
}

function mergePayload(
  base: unknown,
  overrides: Record<string, unknown>,
): unknown {
  if (base === null || typeof base !== "object") {
    return overrides;
  }
  return { ...(base as Record<string, unknown>), ...overrides };
}

// Resolves the DB + repository seams. Mirrors `post-queue-sync.ts`: defaults
// dynamic-import `@anthos/persistence` so the DB connection side effect stays
// out of the static import graph. Tests inject both so the default is never
// hit.
async function resolvePersistence(
  options: QueueResolveHandlerOptions,
): Promise<{
  db: DbOrTx;
  findQueueItemByIdFn: FindQueueItemById;
  applyQueueResolutionFn: ApplyQueueResolution;
}> {
  if (
    options.db !== undefined &&
    options.findQueueItemByIdImpl !== undefined &&
    options.applyQueueResolutionImpl !== undefined
  ) {
    return {
      db: options.db,
      findQueueItemByIdFn: options.findQueueItemByIdImpl,
      applyQueueResolutionFn: options.applyQueueResolutionImpl,
    };
  }
  const persistence = await import("@anthos/persistence");
  return {
    db: options.db ?? persistence.db,
    findQueueItemByIdFn:
      options.findQueueItemByIdImpl ??
      ((dbArg, id) => persistence.repositories.findQueueItemById(dbArg, id)),
    applyQueueResolutionFn:
      options.applyQueueResolutionImpl ??
      ((dbArg, input) =>
        persistence.repositories.applyQueueResolution(dbArg, input)),
  };
}

function errorReason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

