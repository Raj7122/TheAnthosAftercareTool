// PATCH /api/v1/participants/:id/barriers/:barrierId (endpoint E-16) — the
// M-SF close-Barrier mutation per FS v1.12 §F-06 / BR-36 / VR-13. Mirrors the
// canonical composition `withSession(withIdempotency(handler))` + Pattern B
// audit + Pattern D idempotency + M-SF write + per-participant priority
// recompute that P1E-01 established for create-Barrier.
//
// CLOSED-03: closing a Barrier in Salesforce is writing `End_Date__c`;
// `Status__c` is a formula derived from End Date presence and is NEVER written
// from the BFF. This handler's only Salesforce mutation is a PATCH that sets
// `End_Date__c = today`.
//
// Auth: `withSession` (P1A-04) gates entry; this handler enforces caseload
// scope per BR-36 / SEC-AUTHZ-3 (Specialist on own, VP on any; Supervisor is a
// 403 stub here pending the supervisor→supervised mapping — matches P1E-01).
//
// Audit: a `barrier.closed` Pattern B row is written BEFORE the HTTP response
// on each mutation outcome (Immutable #5). SUCCESS on a clean close; FAILED
// on (a) SF outage in the authz pre-read (b) SF error on the PATCH itself
// (c) **VR-13 already-closed rejection** — ticket §Notes EC-20 explicitly
// requires both racing close attempts to audit, so VR-13 is a deliberate
// departure from the "4xx pre-mutation rejections are unaudited" precedent
// P1E-01 established for client-attribute rejections. The barrierId is bound
// on every audit row (including FAILED) via `salesforceRecordId` for cross-
// event reconstruction in P1E-05.
//
// All logic lives here so it stays unit-testable without a Next runtime;
// `apps/web` carries only a thin route shim.

import { writeAuditEntry } from "@anthos/audit";
import {
  SalesforceError,
  SalesforceRestClient,
  assertSalesforceId,
  escapeSoqlString,
  type SalesforceAuth,
} from "@anthos/integrations";
import { createLogger, resolveTraceId } from "@anthos/logging";
import type { StructuredLogger } from "@anthos/logging";
import type { DbOrTx } from "@anthos/persistence";
import type { SessionConfig } from "@anthos/auth";

import { selectSalesforceAuth } from "../salesforce/select-auth.js";
import { scoreCaseload } from "../caseload/score-caseload.js";
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
  closeBarrierRequestSchema,
  type CloseBarrierResponseBody,
  type PriorityRecomputed,
} from "./dto.js";
import {
  closeBarrierSuccessResponse,
  internalErrorResponse,
  notInOwnCaseloadResponse,
  participantNotFoundResponse,
  roleInsufficientScopeResponse,
  salesforceErrorResponse,
  validationFailedResponse,
} from "./responses.js";

const defaultLogger = createLogger({ module: "api.barriers.close" });

// SF Date literal — `YYYY-MM-DD` per Salesforce REST API conventions.
const SF_DATE_RE = /T.*$/;
function formatSalesforceDate(d: Date): string {
  return d.toISOString().replace(SF_DATE_RE, "");
}

function degradedPriorityRecomputed(participantId: string): PriorityRecomputed {
  return {
    participantId,
    score: null,
    tier: null,
    factors: [],
    previousScore: null,
    previousTier: null,
  };
}

function errorReason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Resolves the DB seam. Defaults dynamic-import `@anthos/persistence` so the DB
// connection side effect stays out of the static import graph (mirrors
// handleCreateBarrier). Tests inject `options.db` so the default path is
// never hit.
let defaultDbPromise: Promise<DbOrTx> | undefined;
async function resolveDb(injected: DbOrTx | undefined): Promise<DbOrTx> {
  if (injected !== undefined) return injected;
  defaultDbPromise ??= import("@anthos/persistence").then((m) => m.db);
  return defaultDbPromise;
}

export interface CloseBarrierHandlerOptions {
  // withSession seams.
  readonly store?: SessionStore;
  readonly sessionConfig?: SessionConfig;
  readonly logger?: StructuredLogger;
  // withIdempotency seam.
  readonly idempotencyStore?: IdempotencyStore;
  // M-SF seams. `restClient` overrides both auth and round-trip metering;
  // `salesforceAuth` lets a test swap only the credential path.
  readonly restClient?: SalesforceRestClient;
  readonly salesforceAuth?: SalesforceAuth;
  // Persistence + audit seams.
  readonly db?: DbOrTx;
  readonly writeAudit?: typeof writeAuditEntry;
  // Priority recompute seam — defaults to the live scoreCaseload kernel.
  readonly scoreCaseloadImpl?: typeof scoreCaseload;
  // Server clock seam — resolved once per request so audit + SF End Date +
  // closedAt are stamped against an identical instant.
  readonly now?: () => Date;
}

export type CloseBarrierRouteContext = {
  readonly params:
    | Promise<{ id: string; barrierId: string }>
    | { id: string; barrierId: string };
};

// Next.js App Router entry. The route shim under apps/web/ forwards `req` and
// the dynamic route context here so all logic stays runtime-independent.
export async function handleCloseBarrier(
  req: Request,
  routeCtx: CloseBarrierRouteContext,
  options: CloseBarrierHandlerOptions = {},
): Promise<Response> {
  const traceId = resolveTraceId(req);
  const log = (options.logger ?? defaultLogger).child({ traceId });

  let participantId: string;
  let barrierId: string;
  try {
    const params = await Promise.resolve(routeCtx.params);
    participantId = params.id;
    barrierId = params.barrierId;
  } catch (err) {
    log.error("close-barrier route params resolution failed", {
      event: "barrier_close_params_error",
      reason: errorReason(err),
    });
    return internalErrorResponse(traceId);
  }

  // Compose withSession → withIdempotency → core. Same wrapping shape as
  // handleCreateBarrier; the idempotency middleware narrows ctx to
  // IdempotentRequestContext, merging at the call site keeps the inner
  // handler's `ctx` correctly typed without a cast.
  const idemOptions: WithIdempotencyOptions = {
    ...(options.idempotencyStore !== undefined
      ? { store: options.idempotencyStore }
      : {}),
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
  };

  const sessionCore: SessionHandler = (sessionReq, sessionCtx) => {
    const inner: IdempotentHandler = (idemReq, idemCtx) =>
      runCloseBarrier(
        idemReq,
        { ...sessionCtx, ...idemCtx },
        participantId,
        barrierId,
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
    log.error("close-barrier request failed unexpectedly", {
      event: "barrier_close_internal_error",
      reason: errorReason(err),
    });
    return internalErrorResponse(traceId);
  }
}

// The middleware-resolved core. By this point: session is live, an
// `Idempotency-Key` UUIDv4 is held (the lock guards single execution per key).
async function runCloseBarrier(
  req: Request,
  ctx: SessionRequestContext & IdempotentRequestContext,
  participantId: string,
  barrierId: string,
  options: CloseBarrierHandlerOptions,
  log: StructuredLogger,
): Promise<Response> {
  // Parse + validate the JSON body. An unparseable body is a 422, not a 500
  // — the client sent something we cannot interpret.
  let bodyJson: unknown;
  try {
    const text = await req.text();
    bodyJson = text.length === 0 ? {} : JSON.parse(text);
  } catch {
    return validationFailedResponse(ctx.traceId, {
      field: "body",
      reason: "invalid_json",
    });
  }

  const parseResult = closeBarrierRequestSchema.safeParse(bodyJson);
  if (!parseResult.success) {
    const first = parseResult.error.issues[0];
    const field = first?.path.join(".") || "body";
    return validationFailedResponse(ctx.traceId, {
      field,
      reason: first?.message ?? "validation_failed",
    });
  }
  const validated = parseResult.data;

  try {
    assertSalesforceId(participantId, "participantId");
  } catch {
    return validationFailedResponse(ctx.traceId, {
      field: "participantId",
      reason: "invalid_salesforce_id",
    });
  }
  try {
    assertSalesforceId(barrierId, "barrierId");
  } catch {
    return validationFailedResponse(ctx.traceId, {
      field: "barrierId",
      reason: "invalid_salesforce_id",
    });
  }

  // Resolve the M-SF client (and the DB handle the audit writer rides on).
  const auth = options.salesforceAuth ?? selectSalesforceAuth();
  const restClient = options.restClient ?? new SalesforceRestClient({ auth });
  const db = await resolveDb(options.db);
  const writeAudit = options.writeAudit ?? writeAuditEntry;
  const now = (options.now ?? (() => new Date()))();

  // Single SOQL pre-read: confirms the Barrier exists under the URL's PE
  // (cross-PE references are a 404, NOT a leak of "barrier exists but elsewhere"),
  // reads `End_Date__c` for the VR-13 gate, and reads the parent PE's
  // `Aftercare_Owner__c` via the master-detail relationship for authz scoping.
  // One round-trip on the critical path.
  //
  // An SF outage here is an operational failure on a valid mutation attempt
  // — the request was validated and is about to be role-gated — so it audits
  // as a `barrier.closed` FAILED row before the response (Pattern B /
  // Immutable #5). 4xx pre-mutation rejections (validation, 404, role-gate
  // denial) remain unaudited per P1E-01's precedent; VR-13 is the deliberate
  // exception per EC-20.
  let endDate: string | null;
  let ownerId: string | null;
  try {
    const soql =
      `SELECT End_Date__c, Program_Enrollment__r.Aftercare_Owner__c ` +
      `FROM Barriers__c ` +
      `WHERE Id = '${escapeSoqlString(barrierId)}' ` +
      `AND Program_Enrollment__c = '${escapeSoqlString(participantId)}' ` +
      `LIMIT 1`;
    const result = await restClient.query<{
      End_Date__c: string | null;
      Program_Enrollment__r: { Aftercare_Owner__c: string | null } | null;
    }>(soql);
    if (result.records.length === 0) {
      return participantNotFoundResponse(ctx.traceId);
    }
    const row = result.records[0]!;
    endDate = row.End_Date__c ?? null;
    ownerId = row.Program_Enrollment__r?.Aftercare_Owner__c ?? null;
  } catch (err) {
    if (err instanceof SalesforceError) {
      await writeAudit(db, {
        specialistId: ctx.specialistId,
        actionType: "barrier.closed",
        outcome: "FAILED",
        participantId,
        channel: "system",
        salesforceRecordId: barrierId,
        traceId: ctx.traceId,
        payloadMetadata: {
          source: "tool",
          sf_code: err.code,
          failure_phase: "authz_lookup",
        },
      });
      log.error("barrier close authz lookup failed", {
        event: "barrier_close_authz_sf_error",
        sf_code: err.code,
        reason: err.message,
      });
      return salesforceErrorResponse(err, ctx.traceId);
    }
    throw err;
  }

  // VR-13 (cannot re-close): if End_Date is already populated, reject 422 AND
  // emit a FAILED audit row. Ticket §Notes EC-20 explicitly requires that
  // racing close attempts both audit — this is a deliberate departure from
  // P1E-01's "skip 4xx pre-mutation rejections" precedent because VR-13
  // represents a mutation attempt on a contested resource, not a client-
  // attribute rejection.
  if (endDate !== null) {
    await writeAudit(db, {
      specialistId: ctx.specialistId,
      actionType: "barrier.closed",
      outcome: "FAILED",
      participantId,
      channel: "system",
      salesforceRecordId: barrierId,
      traceId: ctx.traceId,
      payloadMetadata: {
        source: "tool",
        failure_phase: "already_closed",
      },
    });
    return validationFailedResponse(ctx.traceId, {
      field: "barrier",
      reason: "already_closed",
    });
  }

  // Role gate (BR-36 / SEC-AUTHZ-3) — identical matrix to P1E-01 (BR-35).
  // SPECIALIST → own caseload only; VP → any; SUPERVISOR → 403 stub pending
  // supervisor→supervised mapping; SYSTEM_ADMIN is permanently out of scope.
  // BR-36's allowed roles mirror BR-35 verbatim — EC-21 confirms no creator-
  // only restriction on close.
  if (ctx.role === "SPECIALIST") {
    if (ownerId === null || ownerId !== ctx.specialistId) {
      // Null-owner collapses into NOT_IN_OWN_CASELOAD: an orphan
      // Aftercare_Owner__c is observably different from "this PE belongs to
      // someone else," but neither admits the SPECIALIST to act, and the
      // canonical error code per API §9 catalog is the same. A `warn` log
      // here lets operations diagnose data-quality issues (orphan owners on
      // a Barrier's parent PE) without changing the wire surface.
      if (ownerId === null) {
        log.warn("barrier close: parent PE has null Aftercare_Owner__c", {
          event: "barrier_close_pe_orphan_owner",
        });
      }
      return notInOwnCaseloadResponse(ctx.traceId);
    }
  } else if (ctx.role === "VP") {
    // any-caseload — no further scope check
  } else if (ctx.role === "SUPERVISOR") {
    // TODO(P1C-follow-up): wire supervisor→supervised mapping and replace
    // this stub with a same-shape check against the supervised set. When the
    // supervised lookup lands and round-trips Salesforce, an SF failure on
    // that lookup MUST emit the same `barrier.closed` FAILED audit row (with
    // `failure_phase: "authz_lookup"`) as the existing pre-read above, per
    // Pattern B / Immutable #5.
    return roleInsufficientScopeResponse(
      ctx.traceId,
      "supervisor_scope_unmapped",
    );
  } else {
    // SYSTEM_ADMIN or any value the CHECK constraint admits but BR-36 excludes.
    return roleInsufficientScopeResponse(ctx.traceId, "role_not_permitted");
  }

  // M-SF PATCH — write `End_Date__c = today`. Status__c is a SF formula
  // derived from End_Date presence (CLOSED-03) and is never written.
  try {
    await restClient.updateRecord("Barriers__c", barrierId, {
      End_Date__c: formatSalesforceDate(now),
    });
  } catch (err) {
    if (err instanceof SalesforceError) {
      await writeAudit(db, {
        specialistId: ctx.specialistId,
        actionType: "barrier.closed",
        outcome: "FAILED",
        participantId,
        channel: "system",
        salesforceRecordId: barrierId,
        traceId: ctx.traceId,
        payloadMetadata: {
          source: "tool",
          sf_code: err.code,
          failure_phase: "close",
        },
      });
      log.warn("barrier salesforce close failed", {
        event: "barrier_close_sf_error",
        sf_code: err.code,
        reason: err.message,
      });
      return salesforceErrorResponse(err, ctx.traceId);
    }
    throw err;
  }

  // Per-participant priority recompute. Best-effort: if the scoring kernel
  // throws, the close has still landed in SF, so we return a shape-correct
  // null priorityRecomputed rather than 5xx-ing the user. Cache write-through
  // is P1C-02/03's job.
  let priorityRecomputed = degradedPriorityRecomputed(participantId);
  if (ownerId !== null) {
    try {
      const scoring = await (options.scoreCaseloadImpl ?? scoreCaseload)(
        ownerId,
        {
          now: () => now,
          logger: log,
          hydrateOptions: { auth },
        },
      );
      const match = scoring.scored.find(
        (p) => p.snapshot.participantId === participantId,
      );
      if (match !== undefined && match.engine !== null) {
        priorityRecomputed = {
          participantId,
          score: match.engine.priorityScore,
          tier: match.engine.tier,
          factors: match.engine.factors.map((f) => ({
            key: f.key,
            name: f.name,
            valueLabel: f.valueLabel,
            valueNumeric: f.valueNumeric,
            weight: f.weight,
            pointsContributed: f.pointsContributed,
          })),
          previousScore: null,
          previousTier: null,
        };
      }
    } catch (err) {
      log.warn("barrier close priority recompute failed (best-effort)", {
        event: "barrier_close_recompute_failed",
        reason: errorReason(err),
      });
    }
  }

  // SUCCESS audit row BEFORE response (Immutable #5). closureReason text is
  // intentionally NOT written here — it's free-form user input and would
  // carry PII risk if it landed in payload_metadata (SEC-AUDIT-4). The
  // `closure_reason_provided` boolean is a safe structural fact.
  await writeAudit(db, {
    specialistId: ctx.specialistId,
    actionType: "barrier.closed",
    outcome: "SUCCESS",
    participantId,
    channel: "system",
    salesforceRecordId: barrierId,
    traceId: ctx.traceId,
    payloadMetadata: {
      source: "tool",
      closure_reason_provided: validated.closureReason !== undefined,
    },
  });

  const responseBody: CloseBarrierResponseBody = {
    barrierId,
    participantId,
    status: "closed",
    closedAt: now.toISOString(),
    closedBy: ctx.specialistId,
    closureReason: validated.closureReason ?? null,
    priorityRecomputed,
  };
  return closeBarrierSuccessResponse(responseBody, ctx.traceId);
}
