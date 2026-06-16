// POST /api/v1/participants/:id/visits (endpoint E-13) — schedule a Stability
// Visit. Mirrors the Log-a-Call composition: withSession(withIdempotency) +
// Pattern B audit-before-response + Pattern D idempotency + real Salesforce
// write.
//
// Data model (ERD v1.4 / GAP-8 resolved): a visit is an `IDW_Case_Note__c` with
// Type='Stability Meeting'. Scheduling writes Status='Scheduled' +
// Service_Date__c = the visit date. ([TBD-v1.12-3] dedicated scheduled-visit
// storage — representing it as a Status='Scheduled' Case Note is this build's
// defensible default; flagged.)
//
// Outlook: MS Graph is unavailable in Demo (no creds) → MSGraphClient.fromEnv()
// returns null, the handler writes the SF visit only, and returns
// outlookEventId=null / outlookDegraded=true. No throw — the SF write is the
// source of truth and the seam (capability check) lights Outlook up later with
// no handler change.

import { writeAuditEntry } from "@anthos/audit";
import {
  MSGraphClient,
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

import { selectSalesforceAuth } from "../../salesforce/select-auth.js";
import { withIdempotency } from "../../idempotency/middleware.js";
import type {
  IdempotentHandler,
  IdempotentRequestContext,
  WithIdempotencyOptions,
} from "../../idempotency/middleware.js";
import type { IdempotencyStore } from "../../idempotency/store.js";
import { withSession } from "../../session/middleware.js";
import type {
  SessionHandler,
  SessionRequestContext,
  WithSessionOptions,
} from "../../session/middleware.js";
import type { SessionStore } from "../../session/store.js";

import { scheduleVisitRequestSchema, type ScheduleVisitResponseBody } from "./dto.js";
import {
  internalErrorResponse,
  notInOwnCaseloadResponse,
  participantNotFoundResponse,
  roleInsufficientScopeResponse,
  salesforceErrorResponse,
  scheduleVisitSuccessResponse,
  validationFailedResponse,
} from "./responses.js";

const defaultLogger = createLogger({ module: "api.comms.create_visit" });

const CASE_NOTE_SOBJECT = "IDW_Case_Note__c";
const VISIT_TYPE = "Stability Meeting";
const SCHEDULED_STATUS = "Scheduled";
// In-person is the default channel for a scheduled visit; verified picklist
// value on IDW_Case_Note__c.Contact_Type__c.
const DEFAULT_CONTACT_TYPE = "In Person";

const SF_DATE_RE = /T.*$/;
function toSalesforceDate(iso: string): string {
  return iso.replace(SF_DATE_RE, "");
}

function errorReason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

let defaultDbPromise: Promise<DbOrTx> | undefined;
async function resolveDb(injected: DbOrTx | undefined): Promise<DbOrTx> {
  if (injected !== undefined) return injected;
  defaultDbPromise ??= import("@anthos/persistence").then((m) => m.db);
  return defaultDbPromise;
}

export interface ScheduleVisitHandlerOptions {
  readonly store?: SessionStore;
  readonly sessionConfig?: SessionConfig;
  readonly logger?: StructuredLogger;
  readonly idempotencyStore?: IdempotencyStore;
  readonly restClient?: SalesforceRestClient;
  readonly salesforceAuth?: SalesforceAuth;
  readonly db?: DbOrTx;
  readonly writeAudit?: typeof writeAuditEntry;
  // MS Graph seam — defaults to MSGraphClient.fromEnv() (null in Demo). Pass a
  // client to exercise the live Outlook path in tests.
  readonly graphClient?: MSGraphClient | null;
  readonly now?: () => Date;
}

export type RouteContext = {
  readonly params: Promise<{ id: string }> | { id: string };
};

export async function handleScheduleVisit(
  req: Request,
  routeCtx: RouteContext,
  options: ScheduleVisitHandlerOptions = {},
): Promise<Response> {
  const traceId = resolveTraceId(req);
  const log = (options.logger ?? defaultLogger).child({ traceId });

  let participantId: string;
  try {
    const params = await Promise.resolve(routeCtx.params);
    participantId = params.id;
  } catch (err) {
    log.error("schedule-visit route params resolution failed", {
      event: "visit_schedule_params_error",
      reason: errorReason(err),
    });
    return internalErrorResponse(traceId);
  }

  const idemOptions: WithIdempotencyOptions = {
    ...(options.idempotencyStore !== undefined ? { store: options.idempotencyStore } : {}),
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
  };

  const sessionCore: SessionHandler = (sessionReq, sessionCtx) => {
    const inner: IdempotentHandler = (idemReq, idemCtx) =>
      runScheduleVisit(idemReq, { ...sessionCtx, ...idemCtx }, participantId, options, log);
    return withIdempotency(inner, idemOptions)(sessionReq, sessionCtx);
  };

  const sessionOptions: WithSessionOptions = {
    ...(options.store !== undefined ? { store: options.store } : {}),
    ...(options.sessionConfig !== undefined ? { config: options.sessionConfig } : {}),
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
  };

  try {
    return await withSession(sessionCore, sessionOptions)(req);
  } catch (err) {
    log.error("schedule-visit request failed unexpectedly", {
      event: "visit_schedule_internal_error",
      reason: errorReason(err),
    });
    return internalErrorResponse(traceId);
  }
}

async function runScheduleVisit(
  req: Request,
  ctx: SessionRequestContext & IdempotentRequestContext,
  participantId: string,
  options: ScheduleVisitHandlerOptions,
  log: StructuredLogger,
): Promise<Response> {
  let bodyJson: unknown;
  try {
    const text = await req.text();
    bodyJson = text.length === 0 ? {} : JSON.parse(text);
  } catch {
    return validationFailedResponse(ctx.traceId, { field: "body", reason: "invalid_json" });
  }

  const parseResult = scheduleVisitRequestSchema.safeParse(bodyJson);
  if (!parseResult.success) {
    const first = parseResult.error.issues[0];
    return validationFailedResponse(ctx.traceId, {
      field: first?.path.join(".") || "body",
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

  const scheduledWhen = new Date(validated.scheduledDateTime);
  if (Number.isNaN(scheduledWhen.getTime())) {
    return validationFailedResponse(ctx.traceId, {
      field: "scheduledDateTime",
      reason: "invalid_datetime",
    });
  }

  const auth = options.salesforceAuth ?? selectSalesforceAuth();
  const restClient = options.restClient ?? new SalesforceRestClient({ auth });
  const db = await resolveDb(options.db);
  const writeAudit = options.writeAudit ?? writeAuditEntry;
  const graphClient =
    options.graphClient !== undefined ? options.graphClient : MSGraphClient.fromEnv();

  // ── Authz lookup ──────────────────────────────────────────────────────────
  let ownerId: string | null;
  try {
    const soql =
      `SELECT Aftercare_Owner__c FROM IDW_Program_Enrollment__c ` +
      `WHERE Id = '${escapeSoqlString(participantId)}' LIMIT 1`;
    const result = await restClient.query<{ Aftercare_Owner__c: string | null }>(soql);
    if (result.records.length === 0) {
      return participantNotFoundResponse(ctx.traceId);
    }
    ownerId = result.records[0]?.Aftercare_Owner__c ?? null;
  } catch (err) {
    if (err instanceof SalesforceError) {
      await writeAudit(db, {
        specialistId: ctx.specialistId,
        actionType: "visit.scheduled",
        outcome: "FAILED",
        participantId,
        channel: "system",
        traceId: ctx.traceId,
        payloadMetadata: { source: "tool", sf_code: err.code, failure_phase: "authz_lookup" },
      });
      log.error("schedule-visit authz lookup failed", {
        event: "visit_scheduled_authz_sf_error",
        sf_code: err.code,
        reason: err.message,
      });
      return salesforceErrorResponse(err, ctx.traceId);
    }
    throw err;
  }

  // ── Role gate ─────────────────────────────────────────────────────────────
  if (ctx.role === "SPECIALIST") {
    if (ownerId === null || ownerId !== ctx.specialistId) {
      return notInOwnCaseloadResponse(ctx.traceId);
    }
  } else if (ctx.role === "VP") {
    // any-caseload
  } else if (ctx.role === "SUPERVISOR") {
    return roleInsufficientScopeResponse(ctx.traceId, "supervisor_scope_unmapped");
  } else {
    return roleInsufficientScopeResponse(ctx.traceId, "role_not_permitted");
  }

  // ── SF visit write (Case Note Type='Stability Meeting', Status='Scheduled') ─
  let visitId: string;
  try {
    const fields: Record<string, unknown> = {
      Program_Enrollment__c: participantId,
      Type__c: VISIT_TYPE,
      Status__c: SCHEDULED_STATUS,
      Service_Date__c: toSalesforceDate(validated.scheduledDateTime),
      Contact_Type__c: DEFAULT_CONTACT_TYPE,
      ...(validated.notes !== undefined ? { Case_Note__c: validated.notes } : {}),
    };
    const created = await restClient.createRecord(CASE_NOTE_SOBJECT, fields);
    visitId = created.id;
  } catch (err) {
    if (err instanceof SalesforceError) {
      await writeAudit(db, {
        specialistId: ctx.specialistId,
        actionType: "visit.scheduled",
        outcome: "FAILED",
        participantId,
        channel: "in_person",
        traceId: ctx.traceId,
        payloadMetadata: { source: "tool", sf_code: err.code, failure_phase: "create" },
      });
      log.warn("schedule-visit salesforce create failed", {
        event: "visit_scheduled_sf_error",
        sf_code: err.code,
        reason: err.message,
      });
      return salesforceErrorResponse(err, ctx.traceId);
    }
    throw err;
  }

  // ── Outlook invite (degraded when Graph unavailable) ──────────────────────
  // The capability seam: a null client means no creds → SF-only, no throw. The
  // MSGraphClient adapter (P3A-01) is built + unit-tested; wiring its
  // createInvite into this handler additionally needs an SF-user → Graph
  // mailbox mapping ([TBD], owed alongside the PF-08 creds). Until both land the
  // visit is SF-only and outlookEventId is null. When wired, a Graph failure
  // MUST degrade to null here — it must never fail the SF-backed visit.
  const outlookEventId: string | null = null;
  const outlookDegraded = graphClient === null;

  // ── Audit BEFORE response (Immutable #5) ──────────────────────────────────
  await writeAudit(db, {
    specialistId: ctx.specialistId,
    actionType: "visit.scheduled",
    outcome: "SUCCESS",
    participantId,
    channel: "in_person",
    salesforceRecordId: visitId,
    traceId: ctx.traceId,
    payloadMetadata: {
      source: "tool",
      visit_type: VISIT_TYPE,
      outlook_degraded: outlookDegraded,
    },
  });

  const responseBody: ScheduleVisitResponseBody = {
    visitId,
    outlookEventId,
    smsConfirmationId: null,
    scheduledDateTime: scheduledWhen.toISOString(),
    participantNotificationChannel: "none",
    participantNotificationStatus: outlookDegraded ? "degraded" : "skipped",
    statusLabel: "Scheduled",
    outlookDegraded,
  };

  return scheduleVisitSuccessResponse(responseBody, ctx.traceId);
}
