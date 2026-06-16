// POST /api/v1/participants/:id/visits/:visitId/log (P3A-03) — log a completed
// Stability Visit.
//
// DELIBERATE, HUMAN-AUTHORIZED DIVERGENCE FROM API v1.3: the canonical spec
// folds visit-logging into E-13 as `action='log'`. Rajiv chose the P3A-03
// ticket's dedicated `POST /visits/:visitId/log` path (2026-06-03). This must be
// surfaced in the PR body, and the API spec reconciled to match afterward.
//
// Implementation path (GAP-8, resolved 2026-05-17): PROGRAMMATIC Case Note +
// Survey writes via direct sObject REST — NOT a Screen Flow REST invocation
// (screen flows are not indexed by the Actions API). This handler updates the
// scheduled visit's Case Note (Type='Stability Meeting') to Status='Completed'
// and creates a linked `Survey__c`, then credits the nearest preceding
// checkpoint (BR-25) via the existing pure `creditCheckpoint` (P1D-02) — the
// write-side application that satisfies P3A-06.
//
// Composition mirrors the other mutations: withSession(withIdempotency) +
// Pattern B audit-before-response + Pattern D idempotency.
//
// [TBD] Survey field mapping: the survey block (housingStability, …) field API
// names on `Survey__c` are owed by Erik (I-06). For now the Survey is created
// minimally (linked to the PE + Case Note); the block content is not yet mapped.

import { writeAuditEntry } from "@anthos/audit";
import { creditCheckpoint } from "@anthos/domain";
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

import { logVisitRequestSchema, type LogVisitResponseBody } from "./dto.js";
import {
  internalErrorResponse,
  logVisitSuccessResponse,
  notInOwnCaseloadResponse,
  roleInsufficientScopeResponse,
  salesforceErrorResponse,
  validationFailedResponse,
  visitNotFoundResponse,
} from "./responses.js";

const defaultLogger = createLogger({ module: "api.comms.log_visit" });

const CASE_NOTE_SOBJECT = "IDW_Case_Note__c";
const SURVEY_SOBJECT = "Survey__c";
const VISIT_TYPE = "Stability Meeting";
const COMPLETED_STATUS = "Completed";

const SF_DATE_RE = /T.*$/;
function toSalesforceDate(iso: string): string {
  return iso.replace(SF_DATE_RE, "");
}

function parseSfDate(value: string | null): Date | null {
  if (value === null || value.length === 0) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
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

interface VisitRow {
  readonly Type__c: string | null;
  readonly Program_Enrollment__c: string | null;
  readonly Program_Enrollment__r: {
    readonly Aftercare_Owner__c: string | null;
    readonly Aftercare_Start_Date__c: string | null;
  } | null;
}

export interface LogVisitHandlerOptions {
  readonly store?: SessionStore;
  readonly sessionConfig?: SessionConfig;
  readonly logger?: StructuredLogger;
  readonly idempotencyStore?: IdempotencyStore;
  readonly restClient?: SalesforceRestClient;
  readonly salesforceAuth?: SalesforceAuth;
  readonly db?: DbOrTx;
  readonly writeAudit?: typeof writeAuditEntry;
  readonly now?: () => Date;
}

export type RouteContext = {
  readonly params: Promise<{ id: string; visitId: string }> | { id: string; visitId: string };
};

export async function handleLogVisit(
  req: Request,
  routeCtx: RouteContext,
  options: LogVisitHandlerOptions = {},
): Promise<Response> {
  const traceId = resolveTraceId(req);
  const log = (options.logger ?? defaultLogger).child({ traceId });

  let participantId: string;
  let visitId: string;
  try {
    const params = await Promise.resolve(routeCtx.params);
    participantId = params.id;
    visitId = params.visitId;
  } catch (err) {
    log.error("log-visit route params resolution failed", {
      event: "visit_log_params_error",
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
      runLogVisit(idemReq, { ...sessionCtx, ...idemCtx }, participantId, visitId, options, log);
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
    log.error("log-visit request failed unexpectedly", {
      event: "visit_log_internal_error",
      reason: errorReason(err),
    });
    return internalErrorResponse(traceId);
  }
}

async function runLogVisit(
  req: Request,
  ctx: SessionRequestContext & IdempotentRequestContext,
  participantId: string,
  visitId: string,
  options: LogVisitHandlerOptions,
  log: StructuredLogger,
): Promise<Response> {
  let bodyJson: unknown;
  try {
    const text = await req.text();
    bodyJson = text.length === 0 ? {} : JSON.parse(text);
  } catch {
    return validationFailedResponse(ctx.traceId, { field: "body", reason: "invalid_json" });
  }

  const parseResult = logVisitRequestSchema.safeParse(bodyJson);
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
    assertSalesforceId(visitId, "visitId");
  } catch {
    return validationFailedResponse(ctx.traceId, {
      field: "visitId",
      reason: "invalid_salesforce_id",
    });
  }

  const auth = options.salesforceAuth ?? selectSalesforceAuth();
  const restClient = options.restClient ?? new SalesforceRestClient({ auth });
  const db = await resolveDb(options.db);
  const writeAudit = options.writeAudit ?? writeAuditEntry;
  const now = (options.now ?? (() => new Date()))();

  // ── Load the visit + owner + aftercare start (one round-trip) ─────────────
  let row: VisitRow | null;
  try {
    const soql =
      `SELECT Type__c, Program_Enrollment__c, ` +
      `Program_Enrollment__r.Aftercare_Owner__c, Program_Enrollment__r.Aftercare_Start_Date__c ` +
      `FROM ${CASE_NOTE_SOBJECT} ` +
      `WHERE Id = '${escapeSoqlString(visitId)}' ` +
      `AND Program_Enrollment__c = '${escapeSoqlString(participantId)}' LIMIT 1`;
    const result = await restClient.query<VisitRow>(soql);
    if (result.records.length === 0) {
      return visitNotFoundResponse(ctx.traceId);
    }
    row = result.records[0] ?? null;
  } catch (err) {
    if (err instanceof SalesforceError) {
      await writeAudit(db, {
        specialistId: ctx.specialistId,
        actionType: "visit.logged",
        outcome: "FAILED",
        participantId,
        channel: "system",
        traceId: ctx.traceId,
        payloadMetadata: { source: "tool", sf_code: err.code, failure_phase: "authz_lookup" },
      });
      log.error("log-visit lookup failed", {
        event: "visit_logged_authz_sf_error",
        sf_code: err.code,
        reason: err.message,
      });
      return salesforceErrorResponse(err, ctx.traceId);
    }
    throw err;
  }

  // Must be a Stability Meeting visit on this participant.
  if (row?.Type__c !== VISIT_TYPE) {
    return visitNotFoundResponse(ctx.traceId);
  }

  const ownerId = row.Program_Enrollment__r?.Aftercare_Owner__c ?? null;
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

  // ── Credit the nearest preceding checkpoint (BR-25, pure) ─────────────────
  const occurredAt = validated.occurredAt !== undefined ? new Date(validated.occurredAt) : now;
  const aftercareStart = parseSfDate(row.Program_Enrollment__r?.Aftercare_Start_Date__c ?? null);
  const checkpointCredited = creditCheckpoint(aftercareStart, occurredAt);

  // ── Write: flip the visit to Completed, then create the Survey ────────────
  let surveyId: string | null = null;
  try {
    await restClient.updateRecord(CASE_NOTE_SOBJECT, visitId, {
      Status__c: COMPLETED_STATUS,
      Service_Date__c: toSalesforceDate(occurredAt.toISOString()),
      ...(validated.summary !== undefined ? { Case_Note__c: validated.summary } : {}),
    });
    // Minimal Survey linked to the PE + Case Note. Survey block field mapping
    // is [TBD] (Erik I-06) — block content is not persisted yet.
    const survey = await restClient.createRecord(SURVEY_SOBJECT, {
      Program_Enrollment__c: participantId,
      Case_Note__c: visitId,
    });
    surveyId = survey.id;
  } catch (err) {
    if (err instanceof SalesforceError) {
      await writeAudit(db, {
        specialistId: ctx.specialistId,
        actionType: "visit.logged",
        outcome: "FAILED",
        participantId,
        channel: "in_person",
        traceId: ctx.traceId,
        payloadMetadata: { source: "tool", sf_code: err.code, failure_phase: "create" },
      });
      log.warn("log-visit salesforce write failed", {
        event: "visit_logged_sf_error",
        sf_code: err.code,
        reason: err.message,
      });
      return salesforceErrorResponse(err, ctx.traceId);
    }
    throw err;
  }

  // ── Audit BEFORE response (Immutable #5) ──────────────────────────────────
  await writeAudit(db, {
    specialistId: ctx.specialistId,
    actionType: "visit.logged",
    outcome: "SUCCESS",
    participantId,
    channel: "in_person",
    salesforceRecordId: visitId,
    traceId: ctx.traceId,
    payloadMetadata: {
      source: "tool",
      credited: checkpointCredited !== null,
      credit_anchor: checkpointCredited,
      survey_created: surveyId !== null,
    },
  });

  const responseBody: LogVisitResponseBody = {
    visitId,
    surveyId,
    checkpointCredited,
    status: COMPLETED_STATUS,
    loggedAt: now.toISOString(),
  };
  return logVisitSuccessResponse(responseBody, ctx.traceId);
}
