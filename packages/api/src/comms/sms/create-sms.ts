// POST /api/v1/participants/:id/sms (endpoint E-11) — the F-09 outbound-SMS
// façade per API v1.3. Second-generation mutation handler: it mirrors the
// Log-a-Call composition exactly — `withSession(withIdempotency(handler))` +
// Pattern B audit-before-response + Pattern D idempotency + a real Mogli write
// + per-participant priority recompute.
//
// SMS send model: Mogli represents an outbound message as a
// `Mogli_SMS__SMS__c` record whose insert triggers the managed gateway.
// `MogliClient.sendSms` performs that insert (see packages/integrations mogli).
// In the sandbox only a "Dummy Gateway" exists, so the record enqueues but is
// not delivered — production-shape identical, delivery is a gateway concern.
//
// Quiet hours (Immutable #4): no outbound SMS 9 PM–8 AM in the PARTICIPANT's
// local timezone. Per the immutable this window is HARD-CODED here (not a
// configurable preference), even though `configuration` also carries
// quietHoursStart/EndLocal — the immutable wins. A send inside the window with
// no `scheduledFor` is BLOCKED (409 QUIET_HOURS_BLOCKED) with the next allowed
// window; the SPA may re-submit with `scheduledFor` set to that instant.
//
// Consent (BR-46): the participant's Contact carries Mogli's opt-out flag; an
// opted-out participant is refused (403) before any write.
//
// PII firewall: the message body, recipient phone, and Contact name NEVER enter
// the audit `payloadMetadata` — `@anthos/audit`'s no-PII assertion would throw
// anyway. The audit row carries structural facts only (template_key,
// delivery_status, scheduled, consent_verified, source).
//
// [TBD] Participant timezone: no canonical Salesforce field is named in the
// spec (FS v1.12 E-14). Defaults to America/New_York (org locale) via
// DEFAULT_PARTICIPANT_TZ; thread the real field through the authz SOQL when Erik
// names it (no extra round-trip — add it to the existing SELECT).

import { writeAuditEntry } from "@anthos/audit";
import { evaluateQuietHours, type QuietHoursWindow } from "@anthos/domain";
import {
  MogliClient,
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
import { scoreCaseload } from "../../caseload/score-caseload.js";
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

import {
  sendSmsRequestSchema,
  type PriorityRecomputed,
  type SendSmsResponseBody,
} from "./dto.js";
import {
  consentWithheldResponse,
  internalErrorResponse,
  noPhoneOnFileResponse,
  notInOwnCaseloadResponse,
  participantNotFoundResponse,
  quietHoursBlockedResponse,
  roleInsufficientScopeResponse,
  salesforceErrorResponse,
  sendSmsSuccessResponse,
  validationFailedResponse,
} from "./responses.js";

const defaultLogger = createLogger({ module: "api.comms.create_sms" });

// Immutable #4 — hard-coded quiet-hours window. NOT read from configuration:
// the immutable mandates this is not a configurable preference.
const QUIET_HOURS_WINDOW: QuietHoursWindow = {
  startLocalHHmm: "21:00",
  endLocalHHmm: "08:00",
};

// [TBD] Default participant timezone (org locale) — see file header.
const DEFAULT_PARTICIPANT_TZ = "America/New_York";

// Dummy Gateway Id in `anthoshome3--pursuit` (the only gateway present). In a
// deployed org this is the registered gateway id; injectable via options so a
// real gateway never requires a code change.
const DEMO_GATEWAY_ID = "a3kU80000018tpxIAA";

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

let defaultDbPromise: Promise<DbOrTx> | undefined;
async function resolveDb(injected: DbOrTx | undefined): Promise<DbOrTx> {
  if (injected !== undefined) return injected;
  defaultDbPromise ??= import("@anthos/persistence").then((m) => m.db);
  return defaultDbPromise;
}

// Shape of the authz + recipient SOQL row. One round-trip resolves ownership,
// the Contact link, the Mogli phone, and the opt-out flag.
interface PeSmsRow {
  readonly Aftercare_Owner__c: string | null;
  readonly Contact__c: string | null;
  readonly Contact__r: {
    readonly Mogli_Phone_Number__c: string | null;
    readonly Mogli_SMS__Mogli_Opt_Out__c: boolean | null;
  } | null;
}

export interface SendSmsHandlerOptions {
  readonly store?: SessionStore;
  readonly sessionConfig?: SessionConfig;
  readonly logger?: StructuredLogger;
  readonly idempotencyStore?: IdempotencyStore;
  readonly restClient?: SalesforceRestClient;
  readonly salesforceAuth?: SalesforceAuth;
  readonly db?: DbOrTx;
  readonly writeAudit?: typeof writeAuditEntry;
  readonly scoreCaseloadImpl?: typeof scoreCaseload;
  // Mogli seam — defaults to a MogliClient over the resolved restClient.
  readonly mogliClient?: MogliClient;
  // Gateway id seam — defaults to the Demo Dummy Gateway.
  readonly gatewayId?: string;
  // Quiet-hours seams (testing only — production uses the hard-coded window /
  // org-default tz per Immutable #4).
  readonly quietHoursWindow?: QuietHoursWindow;
  readonly participantTimezone?: string;
  readonly now?: () => Date;
}

export type RouteContext = {
  readonly params: Promise<{ id: string }> | { id: string };
};

export async function handleSendSms(
  req: Request,
  routeCtx: RouteContext,
  options: SendSmsHandlerOptions = {},
): Promise<Response> {
  const traceId = resolveTraceId(req);
  const log = (options.logger ?? defaultLogger).child({ traceId });

  let participantId: string;
  try {
    const params = await Promise.resolve(routeCtx.params);
    participantId = params.id;
  } catch (err) {
    log.error("send-sms route params resolution failed", {
      event: "sms_create_params_error",
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
      runSendSms(
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
    log.error("send-sms request failed unexpectedly", {
      event: "sms_create_internal_error",
      reason: errorReason(err),
    });
    return internalErrorResponse(traceId);
  }
}

async function runSendSms(
  req: Request,
  ctx: SessionRequestContext & IdempotentRequestContext,
  participantId: string,
  options: SendSmsHandlerOptions,
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

  const parseResult = sendSmsRequestSchema.safeParse(bodyJson);
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

  // ── Resolved deps ─────────────────────────────────────────────────────────
  const auth = options.salesforceAuth ?? selectSalesforceAuth();
  const restClient = options.restClient ?? new SalesforceRestClient({ auth });
  const db = await resolveDb(options.db);
  const writeAudit = options.writeAudit ?? writeAuditEntry;
  const mogli = options.mogliClient ?? new MogliClient({ restClient });
  const gatewayId = options.gatewayId ?? DEMO_GATEWAY_ID;
  const quietHoursWindow = options.quietHoursWindow ?? QUIET_HOURS_WINDOW;
  const participantTimezone =
    options.participantTimezone ?? DEFAULT_PARTICIPANT_TZ;
  const now = (options.now ?? (() => new Date()))();

  // ── scheduledFor validation (before any I/O) ──────────────────────────────
  // A future delivery time must be in the future and itself outside quiet
  // hours (we never schedule a send INTO the quiet window).
  let scheduledFor: string | null = null;
  if (validated.scheduledFor !== undefined) {
    const when = new Date(validated.scheduledFor);
    if (Number.isNaN(when.getTime()) || when.getTime() <= now.getTime()) {
      return validationFailedResponse(ctx.traceId, {
        field: "scheduledFor",
        reason: "must_be_future_instant",
      });
    }
    const scheduledDecision = evaluateQuietHours({
      now: when,
      participantTimezone,
      window: quietHoursWindow,
    });
    if (scheduledDecision.blocked) {
      return validationFailedResponse(ctx.traceId, {
        field: "scheduledFor",
        reason: "inside_quiet_hours",
      });
    }
    scheduledFor = when.toISOString();
  }

  // ── Authz + recipient lookup (one round-trip) ─────────────────────────────
  let row: PeSmsRow | null;
  try {
    const soql =
      `SELECT Aftercare_Owner__c, Contact__c, ` +
      `Contact__r.Mogli_Phone_Number__c, Contact__r.Mogli_SMS__Mogli_Opt_Out__c ` +
      `FROM IDW_Program_Enrollment__c ` +
      `WHERE Id = '${escapeSoqlString(participantId)}' LIMIT 1`;
    const result = await restClient.query<PeSmsRow>(soql);
    if (result.records.length === 0) {
      return participantNotFoundResponse(ctx.traceId);
    }
    row = result.records[0] ?? null;
  } catch (err) {
    if (err instanceof SalesforceError) {
      await writeAudit(db, {
        specialistId: ctx.specialistId,
        actionType: "sms.sent",
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
      log.error("send-sms authz lookup failed", {
        event: "sms_sent_authz_sf_error",
        sf_code: err.code,
        reason: err.message,
      });
      return salesforceErrorResponse(err, ctx.traceId);
    }
    throw err;
  }
  const ownerId = row?.Aftercare_Owner__c ?? null;

  // ── Role gate (BR-49 generalized / SEC-AUTHZ-3) ───────────────────────────
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

  // ── Consent gate (BR-46) ──────────────────────────────────────────────────
  // Mogli opt-out on the Contact blocks the send. A missing Contact also blocks
  // (no recipient + no consent signal).
  const contactId = row?.Contact__c ?? null;
  const optedOut = row?.Contact__r?.Mogli_SMS__Mogli_Opt_Out__c === true;
  if (optedOut) {
    return consentWithheldResponse(ctx.traceId);
  }
  if (contactId === null) {
    return noPhoneOnFileResponse(ctx.traceId);
  }

  // ── Recipient phone ───────────────────────────────────────────────────────
  const phone = row?.Contact__r?.Mogli_Phone_Number__c ?? null;
  if (phone === null || phone.trim().length === 0) {
    return noPhoneOnFileResponse(ctx.traceId);
  }

  // ── Quiet hours (Immutable #4) ────────────────────────────────────────────
  // Only enforced for an immediate send. A scheduled send was already validated
  // to land outside the window above.
  if (scheduledFor === null) {
    const decision = evaluateQuietHours({
      now,
      participantTimezone,
      window: quietHoursWindow,
    });
    if (decision.blocked && decision.nextAllowedAtUtc !== null) {
      return quietHoursBlockedResponse(ctx.traceId, {
        nextAllowedWindowStart: decision.nextAllowedAtUtc,
        participantTimezone,
      });
    }
  }

  // ── Mogli write (real per F-09; seam stays for testability) ───────────────
  let sendResult: Awaited<ReturnType<MogliClient["sendSms"]>>;
  try {
    sendResult = await mogli.sendSms({
      phoneNumber: phone,
      message: validated.body,
      contactId,
      programEnrollmentId: participantId,
      gatewayId,
      ...(scheduledFor !== null ? { scheduledDelivery: scheduledFor } : {}),
    });
  } catch (err) {
    if (err instanceof SalesforceError) {
      await writeAudit(db, {
        specialistId: ctx.specialistId,
        actionType: scheduledFor !== null ? "sms.scheduled" : "sms.sent",
        outcome: "FAILED",
        participantId,
        channel: "sms",
        traceId: ctx.traceId,
        payloadMetadata: {
          source: "tool",
          ...(validated.templateKey !== undefined
            ? { template_key: validated.templateKey }
            : {}),
          scheduled: scheduledFor !== null,
          sf_code: err.code,
          ...(err.sfErrorCode !== undefined
            ? { sf_underlying_code: err.sfErrorCode }
            : {}),
          failure_phase: "create",
        },
      });
      log.warn("send-sms mogli create failed", {
        event: "sms_sent_sf_error",
        sf_code: err.code,
        reason: err.message,
      });
      return salesforceErrorResponse(err, ctx.traceId);
    }
    throw err;
  }

  // ── Per-participant priority recompute (best-effort) ──────────────────────
  let priorityRecomputed = degradedPriorityRecomputed(participantId);
  if (ownerId !== null) {
    try {
      const scoring = await (options.scoreCaseloadImpl ?? scoreCaseload)(
        ownerId,
        { now: () => now, logger: log, hydrateOptions: { auth } },
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
      log.warn("send-sms priority recompute failed (best-effort)", {
        event: "sms_recompute_failed",
        reason: errorReason(err),
      });
    }
  }

  // ── SUCCESS audit row BEFORE response (Immutable #5) ──────────────────────
  // No body / phone / name — structural facts only (PII firewall / SEC-AUDIT-4).
  const consentVerifiedAt = now.toISOString();
  await writeAudit(db, {
    specialistId: ctx.specialistId,
    actionType: scheduledFor !== null ? "sms.scheduled" : "sms.sent",
    outcome: "SUCCESS",
    participantId,
    channel: "sms",
    salesforceRecordId: sendResult.smsId,
    traceId: ctx.traceId,
    payloadMetadata: {
      source: "tool",
      ...(validated.templateKey !== undefined
        ? { template_key: validated.templateKey }
        : {}),
      delivery_status: sendResult.deliveryStatus,
      scheduled: scheduledFor !== null,
      consent_verified: true,
    },
  });

  const responseBody: SendSmsResponseBody = {
    smsId: sendResult.smsId,
    mogliMessageId: sendResult.mogliMessageId,
    participantId,
    sentAt: now.toISOString(),
    deliveryStatus: sendResult.deliveryStatus,
    scheduledFor,
    consentVerifiedAt,
    priorityRecomputed,
  };

  return sendSmsSuccessResponse(responseBody, ctx.traceId);
}
