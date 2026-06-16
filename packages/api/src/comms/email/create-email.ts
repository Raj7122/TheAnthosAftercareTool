// POST /api/v1/participants/:id/emails (endpoint E-12) — the F-10 outbound-email
// façade per API v1.3. Mirrors the Log-a-Call / SMS composition:
// `withSession(withIdempotency(handler))` + Pattern B audit-before-response +
// Pattern D idempotency. Email is Salesforce-native: the handler invokes a
// tool-owned autolaunched Flow (TRD v1.9 §) via `SalesforceRestClient.invokeFlow`
// which performs the send and creates the Activity / EmailMessage record.
//
// Status — ADVANCED, NOT CLOSED: the tool-owned email Flow is not yet deployed
// to `anthoshome3--pursuit`. The endpoint is correct and dark: it reads the
// Flow API name from `EMAIL_FLOW_API_NAME` and returns 503 EMAIL_NOT_CONFIGURED
// when unset. It lights up the moment the autolaunched Flow is deployed and its
// API name configured — no code change. (GAP-8: only autolaunched flows are
// REST-invocable; the email Flow must be autolaunched.)
//
// No quiet hours (Immutable #4 is participant-channel/SMS-scoped; email is
// non-quiet-hours per FS v1.12 §F-10). Consent: Contact.HasOptedOutOfEmail
// blocks the send. PII firewall: subject / body NEVER enter audit metadata.

import { writeAuditEntry } from "@anthos/audit";
import {
  EmailFlowClient,
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

import { sendEmailRequestSchema, type SendEmailResponseBody } from "./dto.js";
import {
  emailConsentWithheldResponse,
  emailNotConfiguredResponse,
  internalErrorResponse,
  noEmailOnFileResponse,
  notInOwnCaseloadResponse,
  participantNotFoundResponse,
  roleInsufficientScopeResponse,
  salesforceErrorResponse,
  sendEmailAcceptedResponse,
  validationFailedResponse,
} from "./responses.js";

const defaultLogger = createLogger({ module: "api.comms.create_email" });

function errorReason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

let defaultDbPromise: Promise<DbOrTx> | undefined;
async function resolveDb(injected: DbOrTx | undefined): Promise<DbOrTx> {
  if (injected !== undefined) return injected;
  defaultDbPromise ??= import("@anthos/persistence").then((m) => m.db);
  return defaultDbPromise;
}

// Tool-owned email Flow API name — read from env so deploying + naming the Flow
// is a config change, not a code change. Empty ⇒ email is not yet enabled.
function resolveFlowApiName(injected: string | undefined): string {
  if (injected !== undefined) return injected;
  return process.env.EMAIL_FLOW_API_NAME ?? "";
}

interface PeEmailRow {
  readonly Aftercare_Owner__c: string | null;
  readonly Contact__c: string | null;
  readonly Contact__r: {
    readonly Email: string | null;
    readonly HasOptedOutOfEmail: boolean | null;
  } | null;
}

export interface SendEmailHandlerOptions {
  readonly store?: SessionStore;
  readonly sessionConfig?: SessionConfig;
  readonly logger?: StructuredLogger;
  readonly idempotencyStore?: IdempotencyStore;
  readonly restClient?: SalesforceRestClient;
  readonly salesforceAuth?: SalesforceAuth;
  readonly db?: DbOrTx;
  readonly writeAudit?: typeof writeAuditEntry;
  // Email Flow seam — defaults to an EmailFlowClient over the resolved
  // restClient + the configured flow name.
  readonly emailClient?: EmailFlowClient;
  // Flow API name override (testing). Production reads EMAIL_FLOW_API_NAME.
  readonly flowApiName?: string;
  readonly now?: () => Date;
}

export type RouteContext = {
  readonly params: Promise<{ id: string }> | { id: string };
};

export async function handleSendEmail(
  req: Request,
  routeCtx: RouteContext,
  options: SendEmailHandlerOptions = {},
): Promise<Response> {
  const traceId = resolveTraceId(req);
  const log = (options.logger ?? defaultLogger).child({ traceId });

  let participantId: string;
  try {
    const params = await Promise.resolve(routeCtx.params);
    participantId = params.id;
  } catch (err) {
    log.error("send-email route params resolution failed", {
      event: "email_create_params_error",
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
      runSendEmail(
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
    log.error("send-email request failed unexpectedly", {
      event: "email_create_internal_error",
      reason: errorReason(err),
    });
    return internalErrorResponse(traceId);
  }
}

async function runSendEmail(
  req: Request,
  ctx: SessionRequestContext & IdempotentRequestContext,
  participantId: string,
  options: SendEmailHandlerOptions,
  log: StructuredLogger,
): Promise<Response> {
  // ── Body parse + Zod validation ───────────────────────────────────────────
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

  const parseResult = sendEmailRequestSchema.safeParse(bodyJson);
  if (!parseResult.success) {
    const first = parseResult.error.issues[0];
    const field = first?.path.join(".") || "body";
    return validationFailedResponse(ctx.traceId, {
      field,
      reason: first?.message ?? "validation_failed",
    });
  }
  const validated = parseResult.data;

  // ── Path-param shape validation ───────────────────────────────────────────
  try {
    assertSalesforceId(participantId, "participantId");
  } catch {
    return validationFailedResponse(ctx.traceId, {
      field: "participantId",
      reason: "invalid_salesforce_id",
    });
  }

  // ── Email-not-configured gate (dark until the Flow is deployed) ───────────
  const flowApiName = resolveFlowApiName(options.flowApiName);
  if (flowApiName.length === 0 && options.emailClient === undefined) {
    return emailNotConfiguredResponse(ctx.traceId);
  }

  // ── Resolved deps ─────────────────────────────────────────────────────────
  const auth = options.salesforceAuth ?? selectSalesforceAuth();
  const restClient = options.restClient ?? new SalesforceRestClient({ auth });
  const db = await resolveDb(options.db);
  const writeAudit = options.writeAudit ?? writeAuditEntry;
  const emailClient =
    options.emailClient ?? new EmailFlowClient({ restClient, flowApiName });
  const now = (options.now ?? (() => new Date()))();

  // ── Authz + consent lookup (one round-trip) ───────────────────────────────
  let row: PeEmailRow | null;
  try {
    const soql =
      `SELECT Aftercare_Owner__c, Contact__c, ` +
      `Contact__r.Email, Contact__r.HasOptedOutOfEmail ` +
      `FROM IDW_Program_Enrollment__c ` +
      `WHERE Id = '${escapeSoqlString(participantId)}' LIMIT 1`;
    const result = await restClient.query<PeEmailRow>(soql);
    if (result.records.length === 0) {
      return participantNotFoundResponse(ctx.traceId);
    }
    row = result.records[0] ?? null;
  } catch (err) {
    if (err instanceof SalesforceError) {
      await writeAudit(db, {
        specialistId: ctx.specialistId,
        actionType: "email.sent",
        outcome: "FAILED",
        participantId,
        channel: "system",
        traceId: ctx.traceId,
        payloadMetadata: {
          source: "tool",
          sf_code: err.code,
          ...(err.sfErrorCode !== undefined
            ? { sf_underlying_code: err.sfErrorCode }
            : {}),
          failure_phase: "authz_lookup",
        },
      });
      log.error("send-email authz lookup failed", {
        event: "email_sent_authz_sf_error",
        sf_code: err.code,
        reason: err.message,
      });
      return salesforceErrorResponse(err, ctx.traceId);
    }
    throw err;
  }
  const ownerId = row?.Aftercare_Owner__c ?? null;

  // ── Role gate ─────────────────────────────────────────────────────────────
  if (ctx.role === "SPECIALIST") {
    if (ownerId === null || ownerId !== ctx.specialistId) {
      return notInOwnCaseloadResponse(ctx.traceId);
    }
  } else if (ctx.role === "VP") {
    // any-caseload
  } else if (ctx.role === "SUPERVISOR") {
    return roleInsufficientScopeResponse(
      ctx.traceId,
      "supervisor_scope_unmapped",
    );
  } else {
    return roleInsufficientScopeResponse(ctx.traceId, "role_not_permitted");
  }

  // ── Consent gate (HasOptedOutOfEmail) + recipient presence ────────────────
  if (row?.Contact__r?.HasOptedOutOfEmail === true) {
    return emailConsentWithheldResponse(ctx.traceId);
  }
  const recipientEmail = row?.Contact__r?.Email ?? null;
  if (recipientEmail === null || recipientEmail.trim().length === 0) {
    return noEmailOnFileResponse(ctx.traceId);
  }

  // ── Email send via tool-owned Flow ────────────────────────────────────────
  let sendResult: Awaited<ReturnType<EmailFlowClient["send"]>>;
  try {
    sendResult = await emailClient.send({
      participantId,
      subject: validated.subject,
      bodyHtml: validated.body,
      ...(validated.templateKey !== undefined
        ? { templateKey: validated.templateKey }
        : {}),
    });
  } catch (err) {
    if (err instanceof SalesforceError) {
      await writeAudit(db, {
        specialistId: ctx.specialistId,
        actionType: "email.sent",
        outcome: "FAILED",
        participantId,
        channel: "email",
        traceId: ctx.traceId,
        payloadMetadata: {
          source: "tool",
          ...(validated.templateKey !== undefined
            ? { template_key: validated.templateKey }
            : {}),
          sf_code: err.code,
          ...(err.sfErrorCode !== undefined
            ? { sf_underlying_code: err.sfErrorCode }
            : {}),
          failure_phase: "flow_invoke",
        },
      });
      log.warn("send-email flow invocation failed", {
        event: "email_sent_sf_error",
        sf_code: err.code,
        reason: err.message,
      });
      return salesforceErrorResponse(err, ctx.traceId);
    }
    throw err;
  }

  // ── SUCCESS audit row BEFORE response (Immutable #5) ──────────────────────
  // No subject / body / email address — structural facts only (PII firewall).
  await writeAudit(db, {
    specialistId: ctx.specialistId,
    actionType: "email.sent",
    outcome: "SUCCESS",
    participantId,
    channel: "email",
    salesforceRecordId: sendResult.activityId,
    traceId: ctx.traceId,
    payloadMetadata: {
      source: "tool",
      ...(validated.templateKey !== undefined
        ? { template_key: validated.templateKey }
        : {}),
      consent_checked: true,
    },
  });

  const responseBody: SendEmailResponseBody = {
    emailId: sendResult.emailId,
    participantId,
    sentAt: now.toISOString(),
    subject: validated.subject,
    activityId: sendResult.activityId,
    activityReconciliationStatus: "reconciled",
    consentChecked: true,
  };

  return sendEmailAcceptedResponse(responseBody, ctx.traceId);
}
