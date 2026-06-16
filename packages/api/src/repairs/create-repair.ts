// POST /api/v1/participants/:id/repairs — the M-SF create-Repair mutation.
//
// GOVERNANCE: repairs are NET-NEW / off-spec. The authoritative specs cover
// only `Barriers__c` (F-06); there is no F-*/E-*/ERD entity for `Repair__c`.
// This handler is a deliberate structural clone of `handleCreateBarrier`
// (E-15) so it inherits the canonical mutation shape:
// `withSession(withIdempotency(handler))` + Pattern D idempotency + Pattern B
// audit + M-SF write. It intentionally OMITS the barrier handler's per-
// participant priority recompute — repairs do not feed the BR-19 priority
// engine.
//
// PARTICIPANT LINK: `Repair__c` has no direct FK to the participant. The link
// is two hops: `Repair__c.Unit_Rental__c` → `Unit_Rental__c.Program_Enrollment__c`
// → `IDW_Program_Enrollment__c`. So we resolve the participant's Unit Engagement
// (`Unit_Rental__c`) and set it on the repair. A participant with no Unit
// Engagement yields a surfaced 409 (REPAIR_UNIT_ENGAGEMENT_MISSING), never a
// silent failure. When a participant has multiple Unit Engagements we attach to
// the most-recently-created one (ORDER BY CreatedDate DESC) — Production may
// need a picker; documented here as an off-spec demo simplification.
//
// Audit: a `repair.created` Pattern B row is written BEFORE the HTTP response
// on every mutation outcome (SUCCESS, FAILED) per Immutable #5. The metadata
// carries `source: "tool"` (plus `failure_phase` / `sf_code` on FAILED rows) —
// NEVER the note text, and NEVER a key containing the segment `note` (the no-PII
// denylist rejects `note*` keys).

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
  createRepairRequestSchema,
  type CreateRepairResponseBody,
} from "./dto.js";
import {
  createRepairSuccessResponse,
  internalErrorResponse,
  notInOwnCaseloadResponse,
  noUnitEngagementResponse,
  participantNotFoundResponse,
  roleInsufficientScopeResponse,
  salesforceErrorResponse,
  validationFailedResponse,
} from "./responses.js";

const defaultLogger = createLogger({ module: "api.repairs.create" });

// Server-set status on create — the first state of the repair lifecycle.
const REPAIR_INITIAL_STATUS = "Need Identified" as const;

// SF Date literal — `YYYY-MM-DD` per Salesforce REST API conventions.
const SF_DATE_RE = /T.*$/;
function formatSalesforceDate(d: Date): string {
  return d.toISOString().replace(SF_DATE_RE, "");
}

function errorReason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Resolves the DB seam. Defaults dynamic-import `@anthos/persistence` so the DB
// connection side effect stays out of the static import graph. Tests inject
// `options.db` so the default path is never hit.
let defaultDbPromise: Promise<DbOrTx> | undefined;
async function resolveDb(injected: DbOrTx | undefined): Promise<DbOrTx> {
  if (injected !== undefined) return injected;
  defaultDbPromise ??= import("@anthos/persistence").then((m) => m.db);
  return defaultDbPromise;
}

export interface CreateRepairHandlerOptions {
  // withSession seams.
  readonly store?: SessionStore;
  readonly sessionConfig?: SessionConfig;
  readonly logger?: StructuredLogger;
  // withIdempotency seam.
  readonly idempotencyStore?: IdempotencyStore;
  // M-SF seams.
  readonly restClient?: SalesforceRestClient;
  readonly salesforceAuth?: SalesforceAuth;
  // Persistence + audit seams.
  readonly db?: DbOrTx;
  readonly writeAudit?: typeof writeAuditEntry;
  // Server clock seam — resolved once per request so audit + Identification
  // Date + loggedAt are stamped against an identical instant.
  readonly now?: () => Date;
}

export type RepairRouteContext = {
  readonly params: Promise<{ id: string }> | { id: string };
};

export async function handleCreateRepair(
  req: Request,
  routeCtx: RepairRouteContext,
  options: CreateRepairHandlerOptions = {},
): Promise<Response> {
  const traceId = resolveTraceId(req);
  const log = (options.logger ?? defaultLogger).child({ traceId });

  let participantId: string;
  try {
    const params = await Promise.resolve(routeCtx.params);
    participantId = params.id;
  } catch (err) {
    log.error("create-repair route params resolution failed", {
      event: "repair_create_params_error",
      reason: errorReason(err),
    });
    return internalErrorResponse(traceId);
  }

  // Compose withSession → withIdempotency → core (Immutable #6: idempotency on
  // every mutation, checked after session resolution so the key is bound to the
  // authenticated specialist).
  const idemOptions: WithIdempotencyOptions = {
    ...(options.idempotencyStore !== undefined
      ? { store: options.idempotencyStore }
      : {}),
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
  };

  const sessionCore: SessionHandler = (sessionReq, sessionCtx) => {
    const inner: IdempotentHandler = (idemReq, idemCtx) =>
      runCreateRepair(
        idemReq,
        { ...sessionCtx, ...idemCtx },
        participantId,
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
    log.error("create-repair request failed unexpectedly", {
      event: "repair_create_internal_error",
      reason: errorReason(err),
    });
    return internalErrorResponse(traceId);
  }
}

async function runCreateRepair(
  req: Request,
  ctx: SessionRequestContext & IdempotentRequestContext,
  participantId: string,
  options: CreateRepairHandlerOptions,
  log: StructuredLogger,
): Promise<Response> {
  // Parse + validate the JSON body.
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

  const parseResult = createRepairRequestSchema.safeParse(bodyJson);
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

  // Resolve the M-SF client (and the DB handle the audit writer rides on).
  const auth = options.salesforceAuth ?? selectSalesforceAuth();
  const restClient = options.restClient ?? new SalesforceRestClient({ auth });
  const db = await resolveDb(options.db);
  const writeAudit = options.writeAudit ?? writeAuditEntry;
  const now = (options.now ?? (() => new Date()))();

  // Shared FAILED-audit helper — every operational failure on a validated,
  // role-permitted mutation attempt writes a `repair.created` FAILED row before
  // the response (Pattern B / Immutable #5). No note text, no `note*` key.
  const auditFailed = (failurePhase: string, sfCode?: string): Promise<unknown> =>
    writeAudit(db, {
      specialistId: ctx.specialistId,
      actionType: "repair.created",
      outcome: "FAILED",
      participantId,
      channel: "system",
      traceId: ctx.traceId,
      payloadMetadata: {
        source: "tool",
        failure_phase: failurePhase,
        ...(sfCode !== undefined ? { sf_code: sfCode } : {}),
      },
    });

  // Authz scope (BR-35 / SEC-AUTHZ-3): look up the PE's `Aftercare_Owner__c`.
  let ownerId: string | null;
  try {
    const peSoql =
      `SELECT Aftercare_Owner__c FROM IDW_Program_Enrollment__c ` +
      `WHERE Id = '${escapeSoqlString(participantId)}' LIMIT 1`;
    const result = await restClient.query<{
      Aftercare_Owner__c: string | null;
    }>(peSoql);
    if (result.records.length === 0) {
      return participantNotFoundResponse(ctx.traceId);
    }
    ownerId = result.records[0]?.Aftercare_Owner__c ?? null;
  } catch (err) {
    if (err instanceof SalesforceError) {
      await auditFailed("authz_lookup", err.code);
      log.error("repair authz lookup failed", {
        event: "repair_authz_sf_error",
        sf_code: err.code,
        reason: err.message,
      });
      return salesforceErrorResponse(err, ctx.traceId);
    }
    throw err;
  }

  // Role gate (identical to E-15): SPECIALIST → own caseload; VP → any;
  // SUPERVISOR → 403 stub; SYSTEM_ADMIN → 403 (not in BR-35 allowed roles).
  if (ctx.role === "SPECIALIST") {
    if (ownerId === null || ownerId !== ctx.specialistId) {
      return notInOwnCaseloadResponse(ctx.traceId);
    }
  } else if (ctx.role === "VP") {
    // any-caseload — no further scope check
  } else if (ctx.role === "SUPERVISOR") {
    return roleInsufficientScopeResponse(
      ctx.traceId,
      "supervisor_scope_unmapped",
    );
  } else {
    return roleInsufficientScopeResponse(ctx.traceId, "role_not_permitted");
  }

  // Two-hop participant link: resolve the participant's Unit Engagement
  // (`Unit_Rental__c`). 0 rows → surfaced 409 (+ FAILED audit). ≥1 → attach to
  // the most-recently-created (records[0] after ORDER BY CreatedDate DESC).
  let unitRentalId: string;
  try {
    const urSoql =
      `SELECT Id FROM Unit_Rental__c ` +
      `WHERE Program_Enrollment__c = '${escapeSoqlString(participantId)}' ` +
      `ORDER BY CreatedDate DESC`;
    const urResult = await restClient.query<{ Id: string }>(urSoql);
    const firstId = urResult.records[0]?.Id;
    if (firstId === undefined) {
      await auditFailed("unit_rental_resolution");
      log.warn("repair create has no Unit Engagement to attach to", {
        event: "repair_no_unit_rental",
      });
      return noUnitEngagementResponse(ctx.traceId);
    }
    unitRentalId = firstId;
  } catch (err) {
    if (err instanceof SalesforceError) {
      await auditFailed("unit_rental_resolution", err.code);
      log.error("repair Unit Engagement lookup failed", {
        event: "repair_unit_rental_sf_error",
        sf_code: err.code,
        reason: err.message,
      });
      return salesforceErrorResponse(err, ctx.traceId);
    }
    throw err;
  }

  // M-SF write. Status + Identification Date are server-set. The note always
  // routes to the `Description__c` long-text field. Field API name verified via
  // SF MCP describe of `Repair__c` (2026-06-04).
  const identificationDate = formatSalesforceDate(now);
  const sfPayload: Record<string, unknown> = {
    Status__c: REPAIR_INITIAL_STATUS,
    Identification_Date__c: identificationDate,
    Unit_Rental__c: unitRentalId,
    Description__c: validated.note,
  };

  let repairId: string;
  try {
    const created = await restClient.createRecord("Repair__c", sfPayload);
    repairId = created.id;
  } catch (err) {
    if (err instanceof SalesforceError) {
      await auditFailed("create", err.code);
      log.warn("repair salesforce create failed", {
        event: "repair_create_sf_error",
        sf_code: err.code,
        reason: err.message,
      });
      return salesforceErrorResponse(err, ctx.traceId);
    }
    throw err;
  }

  // SUCCESS audit row BEFORE response (Immutable #5). A throw here propagates to
  // the outer 500 — the success-mutation audit gate is mandatory.
  await writeAudit(db, {
    specialistId: ctx.specialistId,
    actionType: "repair.created",
    outcome: "SUCCESS",
    participantId,
    channel: "system",
    salesforceRecordId: repairId,
    traceId: ctx.traceId,
    payloadMetadata: {
      source: "tool",
    },
  });

  const responseBody: CreateRepairResponseBody = {
    repairId,
    participantId,
    unitRentalId,
    status: REPAIR_INITIAL_STATUS,
    identificationDate,
    note: validated.note,
    loggedAt: now.toISOString(),
    loggedBy: ctx.specialistId,
  };
  return createRepairSuccessResponse(responseBody, ctx.traceId);
}
