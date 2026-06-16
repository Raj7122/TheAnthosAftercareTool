// GET /api/v1/participants/:id/case-notes (endpoint E-09) — the F-07 case-
// note history, paginated per API §10.1 cursor model + §7.4.2 wire shape.
// Composes `withSession` (P1A-04) → path-param + query validation → cursor
// decode → SF identity hydration (for VR-15 authz, mirroring E-08) → authz
// gate → SF case-note query → wire DTO assembly, with a Pattern B audit row
// written BEFORE the response per Immutable #5 (BR-38 / AC-27).
//
// Auth: `withSession` resolves the session; `checkAuthz` (shared with E-08)
// enforces VR-15 — SPECIALIST own / SUPERVISOR stub-403 / VP any /
// SYSTEM_ADMIN denied.
//
// Audit: a `participant.case_notes_listed` row is written on EVERY outcome.
// The ticket §Scope explicitly mandates a pre-response audit row even though
// Pattern B calls reads out-of-scope
// — P1F-01 set the precedent and the BR-40 access trail benefits.
//
// Schema-gap stub (TBD-v1.3-5): `IDW_Case_Note__c` carries no participant
// link in the sandbox (schema-gap question 1). The SF query layer is built
// but returns an empty page; the
// response body carries `dataIssues: ["schema_gap_no_case_note_pe_link"]` so
// the SPA can render a "limited timeline" affordance. When Erick names the
// FK, `querySalesforceCaseNotesPage` flips from stub to real SOQL — the
// handler contract above does not change.
//
// All logic lives here so it stays unit-testable without a Next runtime;
// `apps/web` carries only a thin route shim.

import type { SessionConfig } from "@anthos/auth";
import { writeAuditEntry } from "@anthos/audit";
import {
  SalesforceError,
  SalesforceRestClient,
  assertSalesforceId,
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

import { checkAuthz } from "./authz.js";
import {
  CASE_NOTE_CONTACT_TYPES,
  SCHEMA_GAP_NO_CASE_NOTE_PE_LINK,
  type CaseNoteContactType,
  type CaseNoteItem,
  type CaseNotesPageBody,
} from "./case-notes-dto.js";
import {
  CursorExpiredError,
  CursorInvalidError,
  decodeCursor,
  encodeCursor,
  loadCursorSigningKey,
  type CursorPayload,
} from "./cursor.js";
import {
  hydrateParticipantIdentity,
  type ParticipantIdentity,
} from "./identity-hydration.js";
import {
  caseNotesSuccessResponse,
  cursorExpiredResponse,
  cursorInvalidResponse,
  internalErrorResponse,
  invalidQueryParamResponse,
  participantNotFoundResponse,
  salesforceErrorResponse,
  validationFailedResponse,
} from "./responses.js";

const defaultLogger = createLogger({ module: "api.participants.case_notes" });

// API §7.4.2 / §10.1 — default 30, max 100.
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

export type RouteContext = {
  readonly params: Promise<{ id: string }> | { id: string };
};

// Result returned by the SF query seam. `nextCursorSeed` is `null` on the
// last page; the handler signs it into a wire cursor before returning. The
// `schemaGap` flag is true while TBD-v1.3-5 is open — the SPA renders a
// "limited timeline" badge against the wire body's `dataIssues` marker.
export interface CaseNotesQueryResult {
  readonly items: ReadonlyArray<CaseNoteItem>;
  readonly hasMore: boolean;
  readonly nextCursorSeed: CursorPayload | null;
  readonly schemaGap: boolean;
}

export interface CaseNotesQueryArgs {
  readonly participantId: string;
  readonly cursor: CursorPayload | null;
  readonly limit: number;
  readonly type: string | null;
  readonly contactType: CaseNoteContactType | null;
  readonly restClient: SalesforceRestClient;
}

// SF query seam — today a stub returning an empty page. When Erick names the
// `IDW_Case_Note__c` participant FK (TBD-v1.3-5), swap the body for a real
// SOQL pagination keyed by `(occurredAt, sfRecordId)` per the ticket §Notes
// "Use an opaque cursor … rather than offset pagination — Salesforce result
// sets shift as new case notes land." The handler / response / audit layers
// above do not change.
export type CaseNotesQueryFn = (args: CaseNotesQueryArgs) => Promise<CaseNotesQueryResult>;

const defaultCaseNotesQuery: CaseNotesQueryFn = async (_args) => ({
  items: [],
  hasMore: false,
  nextCursorSeed: null,
  schemaGap: true,
});

export interface GetCaseNotesHandlerOptions {
  // withSession seams.
  readonly store?: SessionStore;
  readonly sessionConfig?: SessionConfig;
  readonly logger?: StructuredLogger;
  // M-SF seams. `restClient` overrides both auth and round-trip metering;
  // `salesforceAuth` lets a test swap only the credential path.
  readonly restClient?: SalesforceRestClient;
  readonly salesforceAuth?: SalesforceAuth;
  // Persistence + audit seams.
  readonly db?: DbOrTx;
  readonly writeAudit?: typeof writeAuditEntry;
  // Identity-hydration seam — defaults to the live SOQL path. Tests inject
  // either a custom rest client (above) or this directly.
  readonly hydrateIdentityImpl?: typeof hydrateParticipantIdentity;
  // SF case-note query seam — defaults to the schema-gap empty-page stub.
  readonly caseNotesQuery?: CaseNotesQueryFn;
  // HMAC signing key seam — defaults to `loadCursorSigningKey(process.env)`.
  // Tests inject a fixed 32-byte buffer so the codec round-trip is hermetic.
  readonly cursorSigningKey?: Buffer;
  // Server clock seam — resolved once per request so audit + cursor age +
  // pagination math align against an identical instant.
  readonly now?: () => Date;
}

// Next.js App Router entry. The route shim under `apps/web/` forwards `req`
// and the dynamic route context here so all logic stays runtime-independent.
export async function handleGetCaseNotes(
  req: Request,
  routeCtx: RouteContext,
  options: GetCaseNotesHandlerOptions = {},
): Promise<Response> {
  const traceId = resolveTraceId(req);
  const log = (options.logger ?? defaultLogger).child({ traceId });

  let participantId: string;
  try {
    const params = await Promise.resolve(routeCtx.params);
    participantId = params.id;
  } catch (err) {
    log.error("get-case-notes route params resolution failed", {
      event: "case_notes_params_error",
      reason: errorReason(err),
    });
    return internalErrorResponse(traceId);
  }

  const core: SessionHandler = (sessionReq, ctx) =>
    runGetCaseNotes(sessionReq, ctx, participantId, options, log);

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
    log.error("get-case-notes request failed unexpectedly", {
      event: "case_notes_internal_error",
      reason: errorReason(err),
    });
    return internalErrorResponse(traceId);
  }
}

async function runGetCaseNotes(
  req: Request,
  ctx: SessionRequestContext,
  participantId: string,
  options: GetCaseNotesHandlerOptions,
  log: StructuredLogger,
): Promise<Response> {
  // ── Path-param shape validation ────────────────────────────────────────────
  try {
    assertSalesforceId(participantId, "participantId");
  } catch {
    return validationFailedResponse(ctx.traceId, {
      field: "participantId",
      reason: "invalid_salesforce_id",
    });
  }

  // ── Query-parameter parsing ────────────────────────────────────────────────
  const url = new URL(req.url);
  const limit = parseLimitOrNull(url.searchParams.get("limit"));
  if (limit === null) {
    return invalidQueryParamResponse(ctx.traceId, { param: "limit" });
  }
  const contactType = parseContactTypeOrError(url.searchParams.get("contactType"));
  if (contactType === "invalid") {
    return invalidQueryParamResponse(ctx.traceId, { param: "contactType" });
  }
  // `type` per API §7.4.2 line 856: pass-through, unknown yields empty page
  // (not 400). The Data Dictionary owns the canonical enum; coupling client
  // validation here would lock it in early.
  const rawType = url.searchParams.get("type");
  const typeFilter =
    rawType !== null && rawType.trim().length > 0 ? rawType.trim() : null;

  // ── Cursor decode ──────────────────────────────────────────────────────────
  const rawCursor = url.searchParams.get("cursor");
  let cursor: CursorPayload | null = null;
  if (rawCursor !== null && rawCursor.length > 0) {
    const signingKey =
      options.cursorSigningKey ?? loadCursorSigningKey();
    try {
      cursor = decodeCursor({
        token: rawCursor,
        specialistId: ctx.specialistId,
        signingKey,
        ...(options.now !== undefined ? { now: options.now } : {}),
      });
    } catch (err) {
      if (err instanceof CursorExpiredError) {
        return cursorExpiredResponse(ctx.traceId);
      }
      if (err instanceof CursorInvalidError) {
        return cursorInvalidResponse(ctx.traceId);
      }
      throw err;
    }
  }

  // ── Resolved deps (after cheap validation, before any SF / DB I/O) ─────────
  const auth = options.salesforceAuth ?? selectSalesforceAuth();
  const restClient = options.restClient ?? new SalesforceRestClient({ auth });
  const db = await resolveDb(options.db);
  const writeAudit = options.writeAudit ?? writeAuditEntry;
  const caseNotesQuery = options.caseNotesQuery ?? defaultCaseNotesQuery;

  // ── Identity hydration (for VR-15 authz + 404 short-circuit) ───────────────
  // E-09 mirrors E-08's authz gate, which is keyed on PE.Aftercare_Owner__c.
  // One SOQL round-trip; same shape as `handleGetParticipant`.
  const hydrateIdentity =
    options.hydrateIdentityImpl ?? hydrateParticipantIdentity;
  let identity: ParticipantIdentity | null;
  try {
    identity = await hydrateIdentity(participantId, { restClient });
  } catch (err) {
    if (err instanceof SalesforceError) {
      await writeAudit(db, {
        specialistId: ctx.specialistId,
        actionType: "participant.case_notes_listed",
        outcome: "FAILED",
        participantId,
        channel: "system",
        traceId: ctx.traceId,
        payloadMetadata: {
          sf_code: err.code,
          failure_phase: "identity_lookup",
          role: ctx.role,
        },
      });
      log.error("case-notes identity lookup failed", {
        event: "case_notes_sf_error",
        sf_code: err.code,
        reason: err.message,
      });
      return salesforceErrorResponse(err, ctx.traceId);
    }
    throw err;
  }

  if (identity === null) {
    return participantNotFoundResponse(ctx.traceId);
  }

  // ── VR-15 authz gate ───────────────────────────────────────────────────────
  const authzDenied = checkAuthz(ctx.role, ctx.specialistId, identity);
  if (authzDenied !== null) {
    await writeAudit(db, {
      specialistId: ctx.specialistId,
      actionType: "participant.case_notes_listed",
      outcome: "FAILED",
      participantId,
      channel: "system",
      traceId: ctx.traceId,
      payloadMetadata: {
        failure_phase: "authz",
        role: ctx.role,
      },
    });
    return authzDenied(ctx.traceId);
  }

  // ── SF case-note query (stub today; flips to real SOQL post-TBD-v1.3-5) ────
  let queryResult: CaseNotesQueryResult;
  try {
    queryResult = await caseNotesQuery({
      participantId,
      cursor,
      limit,
      type: typeFilter,
      contactType,
      restClient,
    });
  } catch (err) {
    if (err instanceof SalesforceError) {
      await writeAudit(db, {
        specialistId: ctx.specialistId,
        actionType: "participant.case_notes_listed",
        outcome: "FAILED",
        participantId,
        channel: "system",
        traceId: ctx.traceId,
        payloadMetadata: {
          sf_code: err.code,
          failure_phase: "case_notes_query",
          role: ctx.role,
        },
      });
      log.error("case-notes query failed", {
        event: "case_notes_query_sf_error",
        sf_code: err.code,
        reason: err.message,
      });
      return salesforceErrorResponse(err, ctx.traceId);
    }
    throw err;
  }

  // ── Build the wire body ────────────────────────────────────────────────────
  // No-op while `queryResult.nextCursorSeed` is always null; the codec runs
  // here once the SF query lights up. Signing key is the one we already
  // resolved for decode (avoids a second env read in the cursor path).
  let nextCursor: string | null = null;
  if (queryResult.nextCursorSeed !== null) {
    const signingKey =
      options.cursorSigningKey ?? loadCursorSigningKey();
    nextCursor = encodeCursor({
      payload: queryResult.nextCursorSeed,
      specialistId: ctx.specialistId,
      signingKey,
    });
  }

  const dataIssues: string[] = [];
  if (queryResult.schemaGap) {
    dataIssues.push(SCHEMA_GAP_NO_CASE_NOTE_PE_LINK);
  }

  const body: CaseNotesPageBody = {
    items: queryResult.items,
    page: {
      nextCursor,
      hasMore: queryResult.hasMore,
      limit,
    },
    dataIssues,
  };

  // ── SUCCESS audit row BEFORE response (Immutable #5) ───────────────────────
  // Participant id rides the dedicated column. Metadata block carries derived
  // counts + filter presence flags only — no PII (no summary, no case-note
  // ids). The schema-gap flag is recorded so post-resolution we can see when
  // real data started flowing.
  await writeAudit(db, {
    specialistId: ctx.specialistId,
    actionType: "participant.case_notes_listed",
    outcome: "SUCCESS",
    participantId,
    channel: "system",
    traceId: ctx.traceId,
    payloadMetadata: {
      role: ctx.role,
      page_count: body.items.length,
      has_more: body.page.hasMore,
      cursor_used: cursor !== null,
      filter_type_present: typeFilter !== null,
      filter_contact_type_present: contactType !== null,
      schema_gap_present: queryResult.schemaGap,
    },
  });

  return caseNotesSuccessResponse(body, ctx.traceId);
}

// `parseLimitOrNull` accepts an absent / missing param (returns DEFAULT_LIMIT),
// rejects non-integer / out-of-range with `null` (handler maps to 400).
function parseLimitOrNull(raw: string | null): number | null {
  if (raw === null || raw.trim().length === 0) return DEFAULT_LIMIT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) return null;
  if (parsed < 1 || parsed > MAX_LIMIT) return null;
  return parsed;
}

// Absent → null (no filter); known enum value → typed; unknown → `"invalid"`.
function parseContactTypeOrError(
  raw: string | null,
): CaseNoteContactType | null | "invalid" {
  if (raw === null || raw.trim().length === 0) return null;
  const value = raw.trim().toLowerCase();
  const match = CASE_NOTE_CONTACT_TYPES.find((v) => v === value);
  return match ?? "invalid";
}

// Resolves the DB seam. Defaults dynamic-import `@anthos/persistence` so the DB
// connection side effect stays out of the static import graph (mirrors
// `handleGetParticipant`). Tests inject `options.db` so the default is never hit.
let defaultDbPromise: Promise<DbOrTx> | undefined;
async function resolveDb(injected: DbOrTx | undefined): Promise<DbOrTx> {
  if (injected !== undefined) return injected;
  defaultDbPromise ??= import("@anthos/persistence").then((m) => m.db);
  return defaultDbPromise;
}

function errorReason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
