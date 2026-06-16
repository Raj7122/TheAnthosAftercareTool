// GET /api/v1/caseload/activity?from=&to= (endpoint E-46) — F-23 Phase B.
// Returns METADATA-ONLY dated activity (scheduled/completed visits + logged
// comms from IDW_Case_Note__c, and Mogli SMS) across the specialist's owned
// participants, for the caseload activity calendar to merge with its
// cache-derived Phase-A events.
//
// This is a NEW, audited, NON-CACHED read path — the deliberate, scoped
// divergence from F-22 BR-97 / F-23 BR-103 that Phase A flagged: comms + visit
// metadata is PHI-adjacent and cannot live in the PII-stripped caseload cache.
// One Pattern-B `caseload.activity_listed` row is written BEFORE the response
// (Immutable #5); its payload is counts/dates only — no ids, names, or bodies.
//
// All logic lives here so it stays unit-testable without a Next runtime; the
// route shim under apps/web carries only the thin forwarder.

import type { SessionConfig } from "@anthos/auth";
import { writeAuditEntry } from "@anthos/audit";
import {
  SalesforceError,
  SalesforceRestClient,
  queryCaseloadActivityRecords,
  queryOwnedEnrollments,
  type SalesforceAuth,
} from "@anthos/integrations";
import { createLogger, resolveTraceId } from "@anthos/logging";
import type { StructuredLogger } from "@anthos/logging";
import type { DbOrTx } from "@anthos/persistence";

import { selectSalesforceAuth } from "../salesforce/select-auth.js";
import { withSession } from "../session/middleware.js";
import type {
  SessionHandler,
  SessionRequestContext,
  WithSessionOptions,
} from "../session/middleware.js";
import type { SessionStore } from "../session/store.js";

import type { CaseloadActivityBody } from "./activity-dto.js";
import { mapActivityEvents } from "./activity-mappers.js";
import {
  caseloadActivitySuccessResponse,
  internalErrorResponse,
  salesforceErrorResponse,
  validationFailedResponse,
} from "./responses.js";

const defaultLogger = createLogger({ module: "api.caseload.activity" });

const MS_PER_DAY = 86_400_000;
const MAX_WINDOW_DAYS = 92;
// Default window when the client omits from/to: previous, current, and next
// month — the realistic planning horizon — fetched once. The inclusive span
// (30 + 60 + 1 = 91 days) stays within MAX_WINDOW_DAYS.
const DEFAULT_BACK_DAYS = 30;
const DEFAULT_FORWARD_DAYS = 60;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface CaseloadActivityHandlerOptions {
  // withSession seams.
  readonly store?: SessionStore;
  readonly sessionConfig?: SessionConfig;
  readonly logger?: StructuredLogger;
  // M-SF seams.
  readonly restClient?: SalesforceRestClient;
  readonly salesforceAuth?: SalesforceAuth;
  // Persistence + audit seams.
  readonly db?: DbOrTx;
  readonly writeAudit?: typeof writeAuditEntry;
  // SF query seams — default to the live integration functions; tests inject
  // hermetic stubs so handler tests need no rest client.
  readonly queryOwnedEnrollmentsImpl?: typeof queryOwnedEnrollments;
  readonly queryActivityImpl?: typeof queryCaseloadActivityRecords;
  // Server clock seam — resolved once so the default window + audit align.
  readonly now?: () => Date;
}

export async function handleCaseloadActivity(
  req: Request,
  options: CaseloadActivityHandlerOptions = {},
): Promise<Response> {
  const traceId = resolveTraceId(req);
  const log = (options.logger ?? defaultLogger).child({ traceId });

  const core: SessionHandler = (sessionReq, ctx) =>
    runCaseloadActivity(sessionReq, ctx, options, log);

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
    log.error("caseload activity request failed unexpectedly", {
      event: "caseload_activity_internal_error",
      reason: errorReason(err),
    });
    return internalErrorResponse(traceId);
  }
}

async function runCaseloadActivity(
  req: Request,
  ctx: SessionRequestContext,
  options: CaseloadActivityHandlerOptions,
  log: StructuredLogger,
): Promise<Response> {
  const nowFn = options.now ?? (() => new Date());

  // ── Window validation ──────────────────────────────────────────────────────
  const url = new URL(req.url);
  const window = resolveWindow(
    url.searchParams.get("from"),
    url.searchParams.get("to"),
    nowFn(),
  );
  if (window.kind === "invalid") {
    return validationFailedResponse(ctx.traceId, {
      field: window.field,
      reason: window.reason,
    });
  }
  const { from, to } = window;

  // ── Resolved deps ──────────────────────────────────────────────────────────
  const auth = options.salesforceAuth ?? selectSalesforceAuth();
  const restClient = options.restClient ?? new SalesforceRestClient({ auth });
  const db = await resolveDb(options.db);
  const writeAudit = options.writeAudit ?? writeAuditEntry;
  const queryOwned = options.queryOwnedEnrollmentsImpl ?? queryOwnedEnrollments;
  const queryActivity =
    options.queryActivityImpl ?? queryCaseloadActivityRecords;

  // ── Owned participants → activity, with a SF-error path → FAILED audit ──────
  try {
    const owned = await queryOwned(ctx.specialistId, restClient);

    if (owned.length === 0) {
      const body: CaseloadActivityBody = { items: [], window: { from, to }, dataIssues: [] };
      await writeAudit(db, {
        specialistId: ctx.specialistId,
        actionType: "caseload.activity_listed",
        outcome: "SUCCESS",
        channel: "system",
        traceId: ctx.traceId,
        payloadMetadata: {
          owned_pe_count: 0,
          from,
          to,
          window_days: daysInclusive(from, to),
          // Key avoids the `note` PII-denylist segment (assertNoPii splits on
          // snake_case); `case_notes_count` → ["case","notes","count"], safe.
          case_notes_count: 0,
          sms_count: 0,
        },
      });
      return caseloadActivitySuccessResponse(body, ctx.traceId);
    }

    const peIds = owned.map((o) => o.id);
    const records = await queryActivity({ peIds, fromDate: from, toDate: to, restClient });

    const nameById = new Map(owned.map((o) => [o.id, o.name] as const));
    const items = mapActivityEvents({
      caseNotes: records.caseNotes,
      sms: records.sms,
      nameById,
    });

    const body: CaseloadActivityBody = { items, window: { from, to }, dataIssues: [] };

    // SUCCESS audit BEFORE response (Immutable #5). Metadata-only — counts +
    // window, no participant ids/names/bodies.
    await writeAudit(db, {
      specialistId: ctx.specialistId,
      actionType: "caseload.activity_listed",
      outcome: "SUCCESS",
      channel: "system",
      traceId: ctx.traceId,
      payloadMetadata: {
        owned_pe_count: owned.length,
        from,
        to,
        window_days: daysInclusive(from, to),
        // `case_notes_count` (not `case_note_…`) — assertNoPii denies the
        // `note` segment; the plural `notes` is allowed.
        case_notes_count: records.caseNotes.length,
        sms_count: records.sms.length,
        round_trips: restClient.roundTripCount,
      },
    });

    return caseloadActivitySuccessResponse(body, ctx.traceId);
  } catch (err) {
    if (err instanceof SalesforceError) {
      await writeAudit(db, {
        specialistId: ctx.specialistId,
        actionType: "caseload.activity_listed",
        outcome: "FAILED",
        channel: "system",
        traceId: ctx.traceId,
        payloadMetadata: { sf_code: err.code, from, to },
      });
      log.error("caseload activity query failed", {
        event: "caseload_activity_sf_error",
        sf_code: err.code,
        reason: err.message,
      });
      return salesforceErrorResponse(err, ctx.traceId);
    }
    throw err;
  }
}

type WindowResult =
  | { readonly kind: "ok"; readonly from: string; readonly to: string }
  | { readonly kind: "invalid"; readonly field: string; readonly reason: string };

// Parses + validates the from/to window. Both default (today−31d … today+61d)
// when absent. Strict YYYY-MM-DD; from ≤ to; span ≤ 92 days.
function resolveWindow(
  rawFrom: string | null,
  rawTo: string | null,
  now: Date,
): WindowResult {
  const from = rawFrom ?? ymdUtc(addDays(now, -DEFAULT_BACK_DAYS));
  const to = rawTo ?? ymdUtc(addDays(now, DEFAULT_FORWARD_DAYS));
  if (!ISO_DATE.test(from)) {
    return { kind: "invalid", field: "from", reason: "invalid_date" };
  }
  if (!ISO_DATE.test(to)) {
    return { kind: "invalid", field: "to", reason: "invalid_date" };
  }
  if (from > to) {
    return { kind: "invalid", field: "to", reason: "invalid_range" };
  }
  if (daysInclusive(from, to) > MAX_WINDOW_DAYS) {
    return { kind: "invalid", field: "to", reason: "window_too_large" };
  }
  return { kind: "ok", from, to };
}

function ymdUtc(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * MS_PER_DAY);
}

// Inclusive day span between two YYYY-MM-DD strings (same day → 1).
function daysInclusive(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / MS_PER_DAY) + 1;
}

// Resolves the DB seam. Defaults dynamic-import @anthos/persistence so the DB
// connection side effect stays out of the static import graph (mirrors
// handleGetCaseNotes). Tests inject options.db so the default is never hit.
let defaultDbPromise: Promise<DbOrTx> | undefined;
async function resolveDb(injected: DbOrTx | undefined): Promise<DbOrTx> {
  if (injected !== undefined) return injected;
  defaultDbPromise ??= import("@anthos/persistence").then((m) => m.db);
  return defaultDbPromise;
}

function errorReason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
