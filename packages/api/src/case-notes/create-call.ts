// POST /api/v1/participants/:id/calls (endpoint E-10) — the F-08 Log-a-Call
// façade per API v1.3 §7.4.3. The second mutation endpoint in the tool
// (barriers / E-15 set the precedent); this handler mirrors that composition
// — `withSession(withIdempotency(handler))` + Pattern B audit + Pattern D
// idempotency + real M-SF write + per-participant priority recompute.
//
// SF write target: `IDW_Case_Note__c` with four fields confirmed by Erick on
// 2026-05-26 and verified live via `FieldDefinition` against `anthos-demo`:
// `Program_Enrollment__c` (participant link), `Service_Date__c`,
// `Contact_Type__c` ("Phone" — path-as-contract), `Case_Note__c` (body).
// `Type__c` / `Status__c` exist on the sobject but are not populated by this
// write (Erick reserved them); they live in audit `payloadMetadata` +
// response body only. P1F-03b flipped this from a no-op stub.
//
// Auth: `withSession` (P1A-04) gates entry; this handler enforces caseload
// scope per BR-49 generalized / SEC-AUTHZ-3 (SPECIALIST own; VP any;
// SUPERVISOR 403 stub pending the supervisor→supervised mapping).
//
// Audit: a `call.logged` Pattern B row is written BEFORE the HTTP response
// on every outcome that reaches the mutation phase (SUCCESS, FAILED
// authz-lookup, FAILED write) per Immutable #5. The action_type matches
// the API §11.6 audit catalog + §6.3 E-10 row + §5.2 lifecycle row + §7.4.3
// sample wire example (all four say `call.logged`); FS v1.12 §F-08 line
// 828 also uses the looser form `case_note.created` for the same audit
// event, but the API catalog is the canonical wire contract and is the
// only place that constrains what values are admissible — `case_note.created`
// is not in the catalog. Surfaced in PR description per the "surface
// conflicts" rule. The audit row carries `status`, `call_type`,
// `contact_type: "phone"`, `source: "tool"`; AC-32 ("source flag = tool")
// is satisfied at this layer (SF holds the row, the audit row holds
// provenance). Summary text NEVER lands in `payloadMetadata` (SEC-AUDIT-4 /
// `@anthos/audit` no-PII assertion). Pre-mutation 4xx rejections
// (validation, 404, role-gate denial) remain unaudited — matches the
// barriers precedent: client-attribute rejections are not mutation outcomes.
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
  SERVICE_DATE_BACKDATE_DAYS,
  SERVICE_DATE_FORWARD_DAYS,
  checkSummaryVr18,
  logCallRequestSchema,
  type LogCallRequest,
  type LogCallResponseBody,
  type PriorityRecomputed,
} from "./dto.js";
import {
  internalErrorResponse,
  logCallSuccessResponse,
  notInOwnCaseloadResponse,
  participantNotFoundResponse,
  roleInsufficientScopeResponse,
  salesforceErrorResponse,
  summaryRequiredForCompletedResponse,
  validationFailedResponse,
} from "./responses.js";

const defaultLogger = createLogger({ module: "api.case_notes.create_call" });

// Salesforce expects date-only as `YYYY-MM-DD`; same helper barriers uses
// (kept local rather than promoted to @anthos/integrations — neither
// handler imports the other and the helper is two lines).
const SF_DATE_RE = /T.*$/;
function formatSalesforceDate(d: Date): string {
  return d.toISOString().replace(SF_DATE_RE, "");
}

// Date-only comparison helpers — service date validation works in calendar
// days against the request-scoped clock. Both compare against `now` after
// truncation to UTC midnight so a fractional-day offset doesn't flake the
// window check across timezones.
function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function parseServiceDateUtc(yyyyMmDd: string): Date | null {
  const [y, m, d] = yyyyMmDd.split("-").map((n) => Number(n));
  if (
    y === undefined ||
    m === undefined ||
    d === undefined ||
    !Number.isInteger(y) ||
    !Number.isInteger(m) ||
    !Number.isInteger(d)
  ) {
    return null;
  }
  const dt = new Date(Date.UTC(y, m - 1, d));
  // Round-trip guard rejects "2026-02-30" → "2026-03-02" silent coercion.
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== m - 1 ||
    dt.getUTCDate() !== d
  ) {
    return null;
  }
  return dt;
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

// Resolves the DB seam. Defaults dynamic-import `@anthos/persistence` so the
// DB connection side effect stays out of the static import graph (mirrors
// `handleCreateBarrier`). Tests inject `options.db`.
let defaultDbPromise: Promise<DbOrTx> | undefined;
async function resolveDb(injected: DbOrTx | undefined): Promise<DbOrTx> {
  if (injected !== undefined) return injected;
  defaultDbPromise ??= import("@anthos/persistence").then((m) => m.db);
  return defaultDbPromise;
}

// ---------------------------------------------------------------------------
// `caseNoteWrite` seam — real Salesforce write (P1F-03b)
// ---------------------------------------------------------------------------

// SF write target — `IDW_Case_Note__c` confirmed by Erick 2026-05-26 and
// verified live via FieldDefinition query against `anthos-demo`.
const CASE_NOTE_SOBJECT = "IDW_Case_Note__c";

// `Contact_Type__c` picklist value for the E-10 path. Path-as-contract: the
// verb encodes "phone", which lands as the literal string `"Phone"` on the SF
// picklist. Verified at apply-time via SF MCP `PicklistValueInfo` on
// 2026-05-26 (admissible values: Email, In Person, Phone, Text/SMS,
// Zoom/Virtual). A picklist mismatch maps to `SF_VALIDATION_FAILED` → 422
// with a clear signal.
const CONTACT_TYPE_PICKLIST_VALUE = "Phone";

// Contract for the underlying SF write. The default implementation writes to
// `IDW_Case_Note__c` with the four confirmed fields below. The seam stays
// injectable so future schema changes (Type__c / Status__c carry-forward when
// Erick names them) can be tested without overriding the runtime; the union's
// `{ written: false }` branch is preserved for paranoia but unreachable from
// `defaultCaseNoteWrite` post-P1F-03b.
export interface CaseNoteWriteArgs {
  readonly participantId: string;
  readonly request: LogCallRequest;
  readonly restClient: SalesforceRestClient;
  readonly auth: SalesforceAuth;
  readonly now: Date;
}

export type CaseNoteWriteResult =
  | { readonly written: true; readonly sfRecordId: string }
  | { readonly written: false; readonly schemaGap: true };

export type CaseNoteWriteFn = (
  args: CaseNoteWriteArgs,
) => Promise<CaseNoteWriteResult>;

// Real write per P1F-03b. Field semantics:
//   - Program_Enrollment__c (Lookup, required) ← PE id from the URL path
//   - Service_Date__c       (Date, required)   ← validated.serviceDate (YYYY-MM-DD)
//   - Contact_Type__c       (Picklist, required) ← "Phone" (path-as-contract)
//   - Case_Note__c          (Rich Text 32768)  ← validated.summary or ""
// `Type__c` and `Status__c` exist on the sobject but Erick did not include
// them in this write — they stay in audit `payloadMetadata` + response body
// only. Future schema work may bring them in; the seam contract holds.
const defaultCaseNoteWrite: CaseNoteWriteFn = async (args) => {
  const sfPayload: Record<string, unknown> = {
    Program_Enrollment__c: args.participantId,
    Service_Date__c: args.request.serviceDate,
    Contact_Type__c: CONTACT_TYPE_PICKLIST_VALUE,
    Case_Note__c: args.request.summary ?? "",
  };
  const created = await args.restClient.createRecord(CASE_NOTE_SOBJECT, sfPayload);
  return { written: true, sfRecordId: created.id };
};

// ---------------------------------------------------------------------------
// Public handler
// ---------------------------------------------------------------------------

export interface LogCallHandlerOptions {
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
  // SF write seam — defaults to the real `createRecord` call against
  // `IDW_Case_Note__c` (P1F-03b). Injectable for testing only; production
  // never overrides this.
  readonly caseNoteWrite?: CaseNoteWriteFn;
  // Server clock seam — resolved once per request so audit, response
  // `loggedAt`, the service-date window, and the SF write timestamp are
  // stamped against an identical instant.
  readonly now?: () => Date;
}

export type RouteContext = {
  readonly params: Promise<{ id: string }> | { id: string };
};

// Next.js App Router entry. The route shim under `apps/web/` forwards `req`
// and the dynamic route context here so all logic stays runtime-independent.
export async function handleLogCall(
  req: Request,
  routeCtx: RouteContext,
  options: LogCallHandlerOptions = {},
): Promise<Response> {
  const traceId = resolveTraceId(req);
  const log = (options.logger ?? defaultLogger).child({ traceId });

  let participantId: string;
  try {
    const params = await Promise.resolve(routeCtx.params);
    participantId = params.id;
  } catch (err) {
    log.error("log-call route params resolution failed", {
      event: "case_note_create_params_error",
      reason: errorReason(err),
    });
    return internalErrorResponse(traceId);
  }

  // Compose withSession → withIdempotency → core. Idempotency required on
  // every mutation (Immutable #6) and checked AFTER session resolution so
  // the key is bound to the authenticated specialist (cross-specialist
  // isolation enforced inside the middleware). `withIdempotency` spreads
  // session context at runtime but its `IdempotentHandler` type narrows to
  // `IdempotentRequestContext`; merging at the call site keeps the inner
  // handler's `ctx` correctly typed without a cast — mirrors barriers.
  const idemOptions: WithIdempotencyOptions = {
    ...(options.idempotencyStore !== undefined
      ? { store: options.idempotencyStore }
      : {}),
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
  };

  const sessionCore: SessionHandler = (sessionReq, sessionCtx) => {
    const inner: IdempotentHandler = (idemReq, idemCtx) =>
      runLogCall(
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
    log.error("log-call request failed unexpectedly", {
      event: "case_note_create_internal_error",
      reason: errorReason(err),
    });
    return internalErrorResponse(traceId);
  }
}

// ---------------------------------------------------------------------------
// Middleware-resolved core
// ---------------------------------------------------------------------------

async function runLogCall(
  req: Request,
  ctx: SessionRequestContext & IdempotentRequestContext,
  participantId: string,
  options: LogCallHandlerOptions,
  log: StructuredLogger,
): Promise<Response> {
  // ── Body parse + Zod validation (VR-16..VR-20, VR-19 max, VR-18 cond) ─────
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

  const parseResult = logCallRequestSchema.safeParse(bodyJson);
  if (!parseResult.success) {
    const first = parseResult.error.issues[0];
    const field = first?.path.join(".") || "body";
    return validationFailedResponse(ctx.traceId, {
      field,
      reason: first?.message ?? "validation_failed",
    });
  }
  const validated = parseResult.data;

  // VR-18 routes to a dedicated 422 code (API §9.3 mapping → §9.4.1 sample)
  // rather than generic VALIDATION_FAILED, so the SPA can render a typed
  // "needs more detail" affordance distinct from other field errors.
  const vr18ActualLength = checkSummaryVr18(validated);
  if (vr18ActualLength !== null) {
    return summaryRequiredForCompletedResponse(ctx.traceId, vr18ActualLength);
  }

  // ── Path-param shape validation (Salesforce 15/18-char id) ────────────────
  try {
    assertSalesforceId(participantId, "participantId");
  } catch {
    return validationFailedResponse(ctx.traceId, {
      field: "participantId",
      reason: "invalid_salesforce_id",
    });
  }

  // ── Resolved deps (after cheap validation, before any SF / DB I/O) ────────
  const auth = options.salesforceAuth ?? selectSalesforceAuth();
  const restClient = options.restClient ?? new SalesforceRestClient({ auth });
  const db = await resolveDb(options.db);
  const writeAudit = options.writeAudit ?? writeAuditEntry;
  const caseNoteWrite = options.caseNoteWrite ?? defaultCaseNoteWrite;
  const now = (options.now ?? (() => new Date()))();

  // ── VR-17 / BR-44 — service-date window against the resolved clock ────────
  const serviceDate = parseServiceDateUtc(validated.serviceDate);
  if (serviceDate === null) {
    return validationFailedResponse(ctx.traceId, {
      field: "serviceDate",
      reason: "invalid_date_shape",
    });
  }
  const todayUtc = startOfUtcDay(now);
  const minServiceDate = new Date(
    todayUtc.getTime() - SERVICE_DATE_BACKDATE_DAYS * 86_400_000,
  );
  const maxServiceDate = new Date(
    todayUtc.getTime() + SERVICE_DATE_FORWARD_DAYS * 86_400_000,
  );
  if (serviceDate < minServiceDate || serviceDate > maxServiceDate) {
    return validationFailedResponse(ctx.traceId, {
      field: "serviceDate",
      reason: "service_date_out_of_window",
    });
  }

  // ── Authz lookup (BR-49 generalized / SEC-AUTHZ-3) ────────────────────────
  // Read `Aftercare_Owner__c` on the PE for the own-caseload comparison. A
  // missing PE is a 404 — Salesforce is the SoR and we persist no parallel
  // participant store. `escapeSoqlString` is belt-and-braces;
  // `assertSalesforceId` already shape-validated the id. A SalesforceError
  // here audits as `case_note.created` FAILED (failure_phase=authz_lookup)
  // before the response, per Immutable #5 / Pattern B. Mirrors the barriers
  // precedent (`create-barrier.ts:280-314`).
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
      // FAILED on authz lookup — channel `"system"` reflects the read-side
      // failure (no participant-channel touched). `failure_phase:
      // "authz_lookup"` distinguishes this row from a write-phase failure.
      await writeAudit(db, {
        specialistId: ctx.specialistId,
        actionType: "call.logged",
        outcome: "FAILED",
        participantId,
        channel: "system",
        traceId: ctx.traceId,
        payloadMetadata: {
          status: validated.status,
          call_type: validated.type,
          contact_type: "phone",
          source: "tool",
          sf_code: err.code,
          ...(err.sfErrorCode !== undefined
            ? { sf_underlying_code: err.sfErrorCode }
            : {}),
          failure_phase: "authz_lookup",
        },
      });
      log.error("log-call authz lookup failed", {
        event: "call_logged_authz_sf_error",
        sf_code: err.code,
        reason: err.message,
      });
      return salesforceErrorResponse(err, ctx.traceId);
    }
    throw err;
  }

  // ── Role gate ─────────────────────────────────────────────────────────────
  // SPECIALIST → own caseload only; VP → any; SUPERVISOR → 403 stub (no
  // supervisor→supervised mapping yet — same TODO barriers carries);
  // anything else (incl. SYSTEM_ADMIN) → 403 `role_not_permitted`. Identical
  // to barriers `:322-343`.
  if (ctx.role === "SPECIALIST") {
    if (ownerId === null || ownerId !== ctx.specialistId) {
      return notInOwnCaseloadResponse(ctx.traceId);
    }
  } else if (ctx.role === "VP") {
    // any-caseload — no further scope check
  } else if (ctx.role === "SUPERVISOR") {
    // TODO(P1C-follow-up): wire supervisor→supervised mapping and replace
    // this stub with a same-shape check against the supervised set.
    // CONTINUITY NOTE: when the supervised lookup lands it will itself
    // round-trip Salesforce (or a tool-side cache) and an upstream SF
    // failure on that round-trip MUST emit the same `case_note.created`
    // FAILED audit row (with `failure_phase: "authz_lookup"`) as the
    // existing Aftercare_Owner__c lookup above, per Pattern B / Immutable #5.
    return roleInsufficientScopeResponse(
      ctx.traceId,
      "supervisor_scope_unmapped",
    );
  } else {
    return roleInsufficientScopeResponse(ctx.traceId, "role_not_permitted");
  }

  // ── SF write (real per P1F-03b; seam stays for testability) ──────────────
  let writeResult: CaseNoteWriteResult;
  try {
    writeResult = await caseNoteWrite({
      participantId,
      request: validated,
      restClient,
      auth,
      now,
    });
  } catch (err) {
    if (err instanceof SalesforceError) {
      // FAILED audit row BEFORE response (Pattern B / Immutable #5). The
      // `sf_underlying_code` key carries the raw SF errorCode when the
      // adapter preserved it (e.g. INVALID_CROSS_REFERENCE_KEY) so the
      // queue-resolver / Pattern E flow downstream is self-describing
      // without re-parsing `err.message`.
      await writeAudit(db, {
        specialistId: ctx.specialistId,
        actionType: "call.logged",
        outcome: "FAILED",
        participantId,
        channel: "phone",
        traceId: ctx.traceId,
        payloadMetadata: {
          status: validated.status,
          call_type: validated.type,
          contact_type: "phone",
          source: "tool",
          sf_code: err.code,
          ...(err.sfErrorCode !== undefined
            ? { sf_underlying_code: err.sfErrorCode }
            : {}),
          failure_phase: "create",
        },
      });
      log.warn("log-call salesforce create failed", {
        event: "call_logged_sf_error",
        sf_code: err.code,
        reason: err.message,
      });
      return salesforceErrorResponse(err, ctx.traceId);
    }
    throw err;
  }

  // Defensive: the seam's union type still admits `{ written: false }` for
  // testability of future schema swaps, but in post-P1F-03b runtime the
  // default never returns it. If an injected fake does, 500 rather than
  // synthesize a stub id — synthesized ids are no longer part of the wire.
  if (!writeResult.written) {
    log.error("log-call write seam returned non-written result", {
      event: "case_note_write_unexpected_not_written",
    });
    return internalErrorResponse(ctx.traceId);
  }
  const caseNoteId = writeResult.sfRecordId;

  // ── Per-participant priority recompute (best-effort) ──────────────────────
  // Same contract barriers ships: if the scoring kernel throws, the case
  // note (or stubbed write) still happened and we return a shape-correct
  // null priorityRecomputed so the SPA falls back to a caseload re-fetch
  // rather than 5xx-ing the user. The cache write-through itself is
  // P1C-02/03 — this handler does NOT write `caseload_cache` (see plan §D2).
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
          // Pre-write score lives on the P1C-02 cache row this handler
          // doesn't touch — null here keeps the wire shape stable.
          previousScore: null,
          previousTier: null,
        };
      }
    } catch (err) {
      log.warn("log-call priority recompute failed (best-effort)", {
        event: "case_note_recompute_failed",
        reason: errorReason(err),
      });
    }
  }

  // ── SUCCESS audit row BEFORE response (Immutable #5) ──────────────────────
  // Channel `"phone"` reflects the verb path encoding the interaction
  // channel (path-as-contract). `salesforceRecordId` is always populated
  // post-P1F-03b — the real SF write returned a 15/18-char id. Summary text
  // NEVER lands here (PII firewall / SEC-AUDIT-4) — the `@anthos/audit`
  // no-PII assertion would throw on `summary` keys anyway. AC-32 ("source
  // flag = tool") is satisfied at this layer: SF holds the case-note row,
  // the audit `payloadMetadata.source: "tool"` carries provenance.
  await writeAudit(db, {
    specialistId: ctx.specialistId,
    actionType: "call.logged",
    outcome: "SUCCESS",
    participantId,
    channel: "phone",
    salesforceRecordId: caseNoteId,
    traceId: ctx.traceId,
    payloadMetadata: {
      status: validated.status,
      call_type: validated.type,
      contact_type: "phone",
      source: "tool",
    },
  });

  // ── Build wire body ───────────────────────────────────────────────────────
  // `dataIssues` is reserved for future schema-gap surfaces (the P1F-03b stub
  // marker is no longer emitted; the constant stays exported in dto.ts for
  // audit-log archaeology of pre-flip rows).
  const occurredAt = validated.occurredAt ?? now.toISOString();
  const dataIssues: string[] = [];

  const responseBody: LogCallResponseBody = {
    caseNoteId,
    participantId,
    status: validated.status,
    type: validated.type,
    contactType: "phone",
    summary: validated.summary ?? null,
    serviceDate: formatSalesforceDate(serviceDate),
    occurredAt,
    loggedAt: now.toISOString(),
    loggedBy: ctx.specialistId,
    source: "tool",
    priorityRecomputed,
    dataIssues,
  };

  return logCallSuccessResponse(responseBody, ctx.traceId);
}
