// POST /api/v1/participants/:id/case-notes — the general "Log Case Note"
// mutation. Writes a real `IDW_Case_Note__c` row via the DIRECT
// `Program_Enrollment__c` participant lookup (no two-hop, unlike repairs).
//
// Structural clone of `handleCreateRepair` / `handleCreateBarrier`: the
// canonical `withSession(withIdempotency(handler))` composition + Pattern D
// idempotency + Pattern B audit + M-SF write. It is a SIBLING to E-10
// `handleLogCall` (`…/calls`), which is the phone-only façade — that handler is
// left untouched. Unlike E-10 this writes `Type__c`, `Contact_Type__c`, and
// `Status__c` (the full case-note shape), and (mirroring repairs) OMITS the
// per-participant priority recompute — last-contact priority refreshes on the
// next caseload load.
//
// Audit: a `case_note.created` Pattern B row is written BEFORE the HTTP response
// on every mutation outcome (Immutable #5). Metadata carries `source`,
// `contact_type`, `activity_type`, `status` — NEVER the note body, and NEVER a
// metadata key containing the segment `note` (the no-PII denylist rejects
// `note*` keys; that is why the meeting kind rides `activity_type`).

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
  createCaseNoteRequestSchema,
  type CreateCaseNoteResponseBody,
} from "./create-case-note-dto.js";
import {
  createCaseNoteSuccessResponse,
  internalErrorResponse,
  notInOwnCaseloadResponse,
  participantNotFoundResponse,
  roleInsufficientScopeResponse,
  salesforceErrorResponse,
  validationFailedResponse,
} from "./responses.js";

const defaultLogger = createLogger({ module: "api.case-notes.create" });

// SF Date literal — `YYYY-MM-DD` per Salesforce REST API conventions.
const SF_DATE_RE = /T.*$/;
function formatSalesforceDate(d: Date): string {
  return d.toISOString().replace(SF_DATE_RE, "");
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

export interface CreateCaseNoteHandlerOptions {
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

export type CaseNoteRouteContext = {
  readonly params: Promise<{ id: string }> | { id: string };
};

export async function handleCreateCaseNote(
  req: Request,
  routeCtx: CaseNoteRouteContext,
  options: CreateCaseNoteHandlerOptions = {},
): Promise<Response> {
  const traceId = resolveTraceId(req);
  const log = (options.logger ?? defaultLogger).child({ traceId });

  let participantId: string;
  try {
    const params = await Promise.resolve(routeCtx.params);
    participantId = params.id;
  } catch (err) {
    log.error("create-case-note route params resolution failed", {
      event: "case_note_create_params_error",
      reason: errorReason(err),
    });
    return internalErrorResponse(traceId);
  }

  const idemOptions: WithIdempotencyOptions = {
    ...(options.idempotencyStore !== undefined
      ? { store: options.idempotencyStore }
      : {}),
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
  };

  const sessionCore: SessionHandler = (sessionReq, sessionCtx) => {
    const inner: IdempotentHandler = (idemReq, idemCtx) =>
      runCreateCaseNote(
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
    log.error("create-case-note request failed unexpectedly", {
      event: "case_note_create_internal_error",
      reason: errorReason(err),
    });
    return internalErrorResponse(traceId);
  }
}

async function runCreateCaseNote(
  req: Request,
  ctx: SessionRequestContext & IdempotentRequestContext,
  participantId: string,
  options: CreateCaseNoteHandlerOptions,
  log: StructuredLogger,
): Promise<Response> {
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

  const parseResult = createCaseNoteRequestSchema.safeParse(bodyJson);
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

  const auth = options.salesforceAuth ?? selectSalesforceAuth();
  const restClient = options.restClient ?? new SalesforceRestClient({ auth });
  const db = await resolveDb(options.db);
  const writeAudit = options.writeAudit ?? writeAuditEntry;
  const now = (options.now ?? (() => new Date()))();

  // Shared FAILED-audit helper — no note body, no `note*` key.
  const auditFailed = (
    failurePhase: string,
    sfCode?: string,
  ): Promise<unknown> =>
    writeAudit(db, {
      specialistId: ctx.specialistId,
      actionType: "case_note.created",
      outcome: "FAILED",
      participantId,
      channel: "system",
      traceId: ctx.traceId,
      payloadMetadata: {
        source: "tool",
        contact_type: validated.contactType,
        activity_type: validated.type,
        status: validated.status,
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
      log.error("case note authz lookup failed", {
        event: "case_note_authz_sf_error",
        sf_code: err.code,
        reason: err.message,
      });
      return salesforceErrorResponse(err, ctx.traceId);
    }
    throw err;
  }

  // Role gate: SPECIALIST → own caseload; VP → any; SUPERVISOR → 403 stub;
  // SYSTEM_ADMIN → 403 (not in BR-35 allowed roles).
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

  // M-SF write. Service Date is server-set to today; the note + picklists are
  // client-supplied. Field API names verified via SF describe of
  // `IDW_Case_Note__c` (2026-06-04). `Program_Enrollment__c` is the direct
  // participant lookup.
  const serviceDate = formatSalesforceDate(now);
  const sfPayload: Record<string, unknown> = {
    Program_Enrollment__c: participantId,
    Case_Note__c: validated.note,
    Service_Date__c: serviceDate,
    Contact_Type__c: validated.contactType,
    Type__c: validated.type,
    Status__c: validated.status,
  };

  let caseNoteId: string;
  try {
    const created = await restClient.createRecord("IDW_Case_Note__c", sfPayload);
    caseNoteId = created.id;
  } catch (err) {
    if (err instanceof SalesforceError) {
      await auditFailed("create", err.code);
      log.warn("case note salesforce create failed", {
        event: "case_note_create_sf_error",
        sf_code: err.code,
        reason: err.message,
      });
      return salesforceErrorResponse(err, ctx.traceId);
    }
    throw err;
  }

  // SUCCESS audit row BEFORE response (Immutable #5).
  await writeAudit(db, {
    specialistId: ctx.specialistId,
    actionType: "case_note.created",
    outcome: "SUCCESS",
    participantId,
    channel: "system",
    salesforceRecordId: caseNoteId,
    traceId: ctx.traceId,
    payloadMetadata: {
      source: "tool",
      contact_type: validated.contactType,
      activity_type: validated.type,
      status: validated.status,
    },
  });

  const responseBody: CreateCaseNoteResponseBody = {
    caseNoteId,
    participantId,
    note: validated.note,
    contactType: validated.contactType,
    type: validated.type,
    status: validated.status,
    serviceDate,
    loggedAt: now.toISOString(),
    loggedBy: ctx.specialistId,
  };
  return createCaseNoteSuccessResponse(responseBody, ctx.traceId);
}
