// POST /api/v1/participants/:id/visits/propose-times (endpoint E-38) — propose
// up to N candidate visit times. Read-shaped (no SF/Graph mutation, no audit
// row) but still requires an Idempotency-Key per API §6.11.
//
// MS Graph is unavailable in Demo, so candidate slots are generated
// DETERMINISTICALLY from the specialist's preferred local windows + the target
// week, and `fallbackUsed: true` is returned. When Graph is live, the same slot
// set would be intersected against the specialist's free/busy; that path is not
// exercised in Demo.
//
// Quiet hours (Immutable #4): no proposed slot may intersect the participant's
// local 9 PM–8 AM window — every candidate is screened through
// `evaluateQuietHours` in the participant timezone before it is offered.

import {
  evaluateQuietHours,
  zonedWallClockToUtc,
  type QuietHoursWindow,
} from "@anthos/domain";
import {
  SalesforceError,
  SalesforceRestClient,
  assertSalesforceId,
  escapeSoqlString,
  type SalesforceAuth,
} from "@anthos/integrations";
import { createLogger, resolveTraceId } from "@anthos/logging";
import type { StructuredLogger } from "@anthos/logging";
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

import {
  proposeTimesRequestSchema,
  type ProposedSlot,
  type ProposeTimesResponseBody,
} from "./dto.js";
import {
  internalErrorResponse,
  notInOwnCaseloadResponse,
  participantNotFoundResponse,
  proposeTimesSuccessResponse,
  roleInsufficientScopeResponse,
  salesforceErrorResponse,
  validationFailedResponse,
} from "./responses.js";

const defaultLogger = createLogger({ module: "api.comms.propose_times" });

const QUIET_HOURS_WINDOW: QuietHoursWindow = {
  startLocalHHmm: "21:00",
  endLocalHHmm: "08:00",
};
const DEFAULT_MAX_SUGGESTIONS = 3;
// Specialist timezone is org-local for Demo; the proposed slots are returned
// with this label. Real specialist-tz threading is a future enhancement.
const SPECIALIST_TZ = "America/New_York";

function errorReason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function parseHhMm(value: string): { hours: number; minutes: number } {
  const [h, m] = value.split(":");
  return { hours: Number(h), minutes: Number(m) };
}

// Deterministic candidate generation. For each day of the target week, emit a
// slot at the start of each matching preferred window, screened against quiet
// hours, ranked chronologically, capped at maxSuggestions.
function generateSlots(args: {
  weekStarting: string;
  preferredWindowsLocal: ReadonlyArray<{ dayOfWeek: number; startTime: string; endTime: string }>;
  estimatedDurationMinutes: number;
  participantTimezone: string;
  maxSuggestions: number;
}): { slots: ProposedSlot[]; insufficientReason: string | null } {
  const [y, m, d] = args.weekStarting.split("-").map(Number);
  const weekStartUtc = Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1);
  const candidates: ProposedSlot[] = [];

  for (let offset = 0; offset < 7; offset += 1) {
    const dayUtc = new Date(weekStartUtc + offset * 86_400_000);
    const dow = dayUtc.getUTCDay();
    for (const window of args.preferredWindowsLocal) {
      if (window.dayOfWeek !== dow) continue;
      const start = parseHhMm(window.startTime);
      const slotStart = zonedWallClockToUtc(
        {
          year: dayUtc.getUTCFullYear(),
          month: dayUtc.getUTCMonth() + 1,
          day: dayUtc.getUTCDate(),
          hours: start.hours,
          minutes: start.minutes,
        },
        args.participantTimezone,
      );
      const slotEnd = new Date(slotStart.getTime() + args.estimatedDurationMinutes * 60_000);

      // Quiet-hours screen (Immutable #4) — reject any slot whose start lands
      // inside the participant's quiet window.
      const decision = evaluateQuietHours({
        now: slotStart,
        participantTimezone: args.participantTimezone,
        window: QUIET_HOURS_WINDOW,
      });
      if (decision.blocked) continue;

      candidates.push({
        slotStart: slotStart.toISOString(),
        slotEnd: slotEnd.toISOString(),
        specialistTimezone: SPECIALIST_TZ,
        rank: 0,
        rationale: `Within a preferred ${window.startTime}–${window.endTime} window; outside quiet hours.`,
      });
    }
  }

  candidates.sort((a, b) => a.slotStart.localeCompare(b.slotStart));
  const ranked = candidates
    .slice(0, args.maxSuggestions)
    .map((slot, i) => ({ ...slot, rank: i + 1 }));
  const insufficientReason =
    ranked.length < args.maxSuggestions
      ? ranked.length === 0
        ? "no_availability_in_windows"
        : "fewer_than_requested_within_windows"
      : null;
  return { slots: ranked, insufficientReason };
}

export interface ProposeTimesHandlerOptions {
  readonly store?: SessionStore;
  readonly sessionConfig?: SessionConfig;
  readonly logger?: StructuredLogger;
  readonly idempotencyStore?: IdempotencyStore;
  readonly restClient?: SalesforceRestClient;
  readonly salesforceAuth?: SalesforceAuth;
}

export type RouteContext = {
  readonly params: Promise<{ id: string }> | { id: string };
};

export async function handleProposeTimes(
  req: Request,
  routeCtx: RouteContext,
  options: ProposeTimesHandlerOptions = {},
): Promise<Response> {
  const traceId = resolveTraceId(req);
  const log = (options.logger ?? defaultLogger).child({ traceId });

  let participantId: string;
  try {
    const params = await Promise.resolve(routeCtx.params);
    participantId = params.id;
  } catch (err) {
    log.error("propose-times route params resolution failed", {
      event: "visit_propose_params_error",
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
      runProposeTimes(idemReq, { ...sessionCtx, ...idemCtx }, participantId, options, log);
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
    log.error("propose-times request failed unexpectedly", {
      event: "visit_propose_internal_error",
      reason: errorReason(err),
    });
    return internalErrorResponse(traceId);
  }
}

async function runProposeTimes(
  req: Request,
  ctx: SessionRequestContext & IdempotentRequestContext,
  participantId: string,
  options: ProposeTimesHandlerOptions,
  log: StructuredLogger,
): Promise<Response> {
  let bodyJson: unknown;
  try {
    const text = await req.text();
    bodyJson = text.length === 0 ? {} : JSON.parse(text);
  } catch {
    return validationFailedResponse(ctx.traceId, { field: "body", reason: "invalid_json" });
  }

  const parseResult = proposeTimesRequestSchema.safeParse(bodyJson);
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

  const auth = options.salesforceAuth ?? selectSalesforceAuth();
  const restClient = options.restClient ?? new SalesforceRestClient({ auth });

  // ── Authz lookup (own-caseload; also validates the participant exists) ────
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
      log.error("propose-times authz lookup failed", {
        event: "visit_propose_authz_sf_error",
        sf_code: err.code,
        reason: err.message,
      });
      return salesforceErrorResponse(err, ctx.traceId);
    }
    throw err;
  }

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

  const maxSuggestions = validated.maxSuggestions ?? DEFAULT_MAX_SUGGESTIONS;
  const { slots, insufficientReason } = generateSlots({
    weekStarting: validated.weekStarting,
    preferredWindowsLocal: validated.preferredWindowsLocal,
    estimatedDurationMinutes: validated.estimatedDurationMinutes,
    participantTimezone: validated.participantTimezone,
    maxSuggestions,
  });

  const responseBody: ProposeTimesResponseBody = {
    proposedSlots: slots,
    graphFreshnessSeconds: 0,
    fallbackUsed: true,
    insufficientReason,
  };
  return proposeTimesSuccessResponse(responseBody, ctx.traceId);
}
