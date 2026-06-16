// POST /api/v1/participants/:id/barriers (endpoint E-15) — the M-SF create-
// Barrier mutation per FS v1.12 §F-06. The first participant-mutation endpoint
// in the tool: it establishes the canonical composition
// `withSession(withIdempotency(handler))` + Pattern B audit + Pattern D
// idempotency + M-SF write + per-participant priority recompute. Other Phase 1
// mutations (calls, sms, emails, visits, close-Barrier) follow this shape.
//
// Auth: `withSession` (P1A-04) gates entry; this handler enforces caseload
// scope per BR-35 / SEC-AUTHZ-3 (Specialist on own, VP on any; Supervisor is a
// 403 stub here pending the supervisor→supervised mapping).
//
// Audit: a `barrier.created` Pattern B row is written BEFORE the HTTP response
// on every outcome (SUCCESS, FAILED) per Immutable #5. The audit row carries
// `barrier_type`, `severity_tier`, and `source: "tool"` — never the
// description, never participant PII (SEC-AUDIT-4 / no-PII assertion).
//
// All logic lives here so it stays unit-testable without a Next runtime;
// `apps/web` carries only a thin route shim.

import { writeAuditEntry } from "@anthos/audit";
import {
  SalesforceError,
  SalesforceRestClient,
  assertSalesforceId,
  escapeSoqlString,
  getKnownBarrierTypes,
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
  createBarrierRequestSchema,
  type BarrierSeverityInput,
  type CreateBarrierResponseBody,
  type PriorityRecomputed,
} from "./dto.js";
import {
  createBarrierSuccessResponse,
  internalErrorResponse,
  notInOwnCaseloadResponse,
  participantNotFoundResponse,
  roleInsufficientScopeResponse,
  salesforceErrorResponse,
  validationFailedResponse,
} from "./responses.js";
import { classifyBarrierSeverity } from "./severity.js";

const defaultLogger = createLogger({ module: "api.barriers.create" });

// SF Date literal — `YYYY-MM-DD` per Salesforce REST API conventions.
const SF_DATE_RE = /T.*$/;
function formatSalesforceDate(d: Date): string {
  return d.toISOString().replace(SF_DATE_RE, "");
}

// Coerce the severity classification to the response-side severity union, or
// null when the Type is out-of-Aftercare-scope. (An Aftercare-stage server-set
// Barrier should never land on `out_of_scope`, but we narrow defensively so the
// response is always wire-correct.)
function deriveResponseSeverity(
  type: string,
  clientOverride: BarrierSeverityInput | undefined,
): BarrierSeverityInput | null {
  if (clientOverride !== undefined) return clientOverride;
  const classified = classifyBarrierSeverity(type);
  if (classified === null || classified === "out_of_scope") return null;
  return classified;
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

// Resolves the DB seam. Defaults dynamic-import `@anthos/persistence` so the DB
// connection side effect stays out of the static import graph (mirrors
// handleCaseload). Tests inject `options.db` so the default path is never hit.
let defaultDbPromise: Promise<DbOrTx> | undefined;
async function resolveDb(injected: DbOrTx | undefined): Promise<DbOrTx> {
  if (injected !== undefined) return injected;
  defaultDbPromise ??= import("@anthos/persistence").then((m) => m.db);
  return defaultDbPromise;
}

export interface CreateBarrierHandlerOptions {
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
  readonly knownBarrierTypes?: ReadonlySet<string>;
  // Server clock seam — resolved once per request so audit + SF Start Date +
  // openedAt are stamped against an identical instant.
  readonly now?: () => Date;
}

export type RouteContext = {
  readonly params: Promise<{ id: string }> | { id: string };
};

// Next.js App Router entry. The route shim under apps/web/ forwards `req` and
// the dynamic route context here so all logic stays runtime-independent.
export async function handleCreateBarrier(
  req: Request,
  routeCtx: RouteContext,
  options: CreateBarrierHandlerOptions = {},
): Promise<Response> {
  const traceId = resolveTraceId(req);
  const log = (options.logger ?? defaultLogger).child({ traceId });

  let participantId: string;
  try {
    const params = await Promise.resolve(routeCtx.params);
    participantId = params.id;
  } catch (err) {
    log.error("create-barrier route params resolution failed", {
      event: "barrier_create_params_error",
      reason: errorReason(err),
    });
    return internalErrorResponse(traceId);
  }

  // Compose withSession → withIdempotency → core. Idempotency is required on
  // every mutation (Immutable #6) and is checked AFTER session resolution so
  // the key is bound to the authenticated specialist (cross-specialist
  // isolation is enforced inside the middleware). `withIdempotency` spreads the
  // session context at runtime but its `IdempotentHandler` type narrows to
  // `IdempotentRequestContext`; merging at the call site keeps the inner
  // handler's `ctx` correctly typed without a cast.
  const idemOptions: WithIdempotencyOptions = {
    ...(options.idempotencyStore !== undefined
      ? { store: options.idempotencyStore }
      : {}),
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
  };

  const sessionCore: SessionHandler = (sessionReq, sessionCtx) => {
    const inner: IdempotentHandler = (idemReq, idemCtx) =>
      runCreateBarrier(
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
    log.error("create-barrier request failed unexpectedly", {
      event: "barrier_create_internal_error",
      reason: errorReason(err),
    });
    return internalErrorResponse(traceId);
  }
}

// The middleware-resolved core. By this point: session is live, an
// `Idempotency-Key` UUIDv4 is held (the lock guards single execution per key).
async function runCreateBarrier(
  req: Request,
  ctx: SessionRequestContext & IdempotentRequestContext,
  participantId: string,
  options: CreateBarrierHandlerOptions,
  log: StructuredLogger,
): Promise<Response> {
  // Parse + validate the JSON body. An unparseable body is a 422, not a 500 —
  // the client sent something we cannot interpret.
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

  const parseResult = createBarrierRequestSchema.safeParse(bodyJson);
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

  // VR-12 / VR-14 — type required + within the cached Salesforce picklist.
  const knownTypes = options.knownBarrierTypes ?? getKnownBarrierTypes();
  if (!knownTypes.has(validated.type)) {
    return validationFailedResponse(ctx.traceId, {
      field: "type",
      reason: "unknown_barrier_type",
    });
  }

  // Resolve the M-SF client (and the DB handle the audit writer rides on).
  const auth = options.salesforceAuth ?? selectSalesforceAuth();
  const restClient = options.restClient ?? new SalesforceRestClient({ auth });
  const db = await resolveDb(options.db);
  const writeAudit = options.writeAudit ?? writeAuditEntry;
  const now = (options.now ?? (() => new Date()))();

  // Authz scope (BR-35 / SEC-AUTHZ-3): look up the PE's `Aftercare_Owner__c`
  // for the own-caseload comparison. A missing PE is a 404 — Salesforce is the
  // SoR and the tool persists no parallel participant store. `escapeSoqlString`
  // is belt-and-braces; `assertSalesforceId` already shape-validated the id.
  //
  // A SalesforceError here (SF outage / governor / network) is an operational
  // failure on a valid mutation attempt — the request was validated and is
  // about to be role-gated — so it audits as a barrier.created FAILED row
  // before the response (Immutable #5 / Pattern B). 4xx pre-mutation
  // rejections (validation, 404, role-gate denial) remain unaudited per the
  // existing in-file precedent — those are client-attribute rejections, not
  // mutation outcomes.
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
      await writeAudit(db, {
        specialistId: ctx.specialistId,
        actionType: "barrier.created",
        outcome: "FAILED",
        participantId,
        channel: "system",
        traceId: ctx.traceId,
        payloadMetadata: {
          barrier_type: validated.type,
          source: "tool",
          sf_code: err.code,
          failure_phase: "authz_lookup",
        },
      });
      log.error("barrier authz lookup failed", {
        event: "barrier_authz_sf_error",
        sf_code: err.code,
        reason: err.message,
      });
      return salesforceErrorResponse(err, ctx.traceId);
    }
    throw err;
  }

  // Role gate. SPECIALIST → own caseload only; VP → any; SUPERVISOR → 403 stub
  // (no supervisor→supervised mapping in the codebase yet — see plan §Authz);
  // SYSTEM_ADMIN is not in BR-35's allowed-roles set. SUPERVISOR and
  // SYSTEM_ADMIN share the canonical `ROLE_INSUFFICIENT_SCOPE` code but the
  // response's `details.reason` distinguishes the temporary-stub vs the
  // permanent-exclusion cases.
  if (ctx.role === "SPECIALIST") {
    if (ownerId === null || ownerId !== ctx.specialistId) {
      return notInOwnCaseloadResponse(ctx.traceId);
    }
  } else if (ctx.role === "VP") {
    // any-caseload — no further scope check
  } else if (ctx.role === "SUPERVISOR") {
    // TODO(P1C-follow-up): wire supervisor→supervised mapping and replace this
    // stub with a same-shape check against the supervised set. CONTINUITY
    // NOTE: when the supervised lookup lands it will itself round-trip
    // Salesforce (or a tool-side cache) and an upstream SF failure on that
    // round-trip MUST emit the same `barrier.created` FAILED audit row (with
    // `failure_phase: "authz_lookup"`) as the existing Aftercare_Owner__c
    // lookup above, per Pattern B / Immutable #5.
    return roleInsufficientScopeResponse(
      ctx.traceId,
      "supervisor_scope_unmapped",
    );
  } else {
    // SYSTEM_ADMIN or any value the CHECK constraint admits but BR-35 excludes.
    return roleInsufficientScopeResponse(ctx.traceId, "role_not_permitted");
  }

  // M-SF write. Stage and Start Date are server-set per BR-33 / ticket §Scope
  // — the client cannot back-date a Barrier or write a non-Aftercare Stage.
  // `Description__c` is the SF API name for the F-06 "Next Steps" field
  // (verified via SF MCP describe of `Barriers__c` 2026-05-22). `Status__c` is
  // a formula and is NOT written.
  const sfPayload: Record<string, unknown> = {
    Type__c: validated.type,
    Stage__c: "Aftercare",
    Start_Date__c: formatSalesforceDate(now),
    Program_Enrollment__c: participantId,
    ...(validated.description !== undefined
      ? { Description__c: validated.description }
      : {}),
  };

  let barrierId: string;
  try {
    const created = await restClient.createRecord("Barriers__c", sfPayload);
    barrierId = created.id;
  } catch (err) {
    if (err instanceof SalesforceError) {
      // FAILED audit row BEFORE response. A throw here (audit/DB failure)
      // surfaces as a 500 via the outer catch — the failed-mutation audit
      // gate is not allowed to silently fail (Pattern B).
      await writeAudit(db, {
        specialistId: ctx.specialistId,
        actionType: "barrier.created",
        outcome: "FAILED",
        participantId,
        channel: "system",
        traceId: ctx.traceId,
        payloadMetadata: {
          barrier_type: validated.type,
          source: "tool",
          sf_code: err.code,
          failure_phase: "create",
        },
      });
      log.warn("barrier salesforce create failed", {
        event: "barrier_create_sf_error",
        sf_code: err.code,
        reason: err.message,
      });
      return salesforceErrorResponse(err, ctx.traceId);
    }
    throw err;
  }

  // Per-participant priority recompute (AC-22 contract). Best-effort: if the
  // scoring kernel throws, the Barrier still exists in SF and we return a
  // shape-correct null priorityRecomputed so the SPA falls back to a caseload
  // re-fetch rather than 5xx-ing the user. The cache write-through itself is
  // P1C-02/03 — this handler does NOT write `caseload_cache`.
  let priorityRecomputed = degradedPriorityRecomputed(participantId);
  if (ownerId !== null) {
    try {
      const scoring = await (options.scoreCaseloadImpl ?? scoreCaseload)(
        ownerId,
        {
          now: () => now,
          logger: log,
          // Hand the scoring kernel the same auth this handler resolved so the
          // recompute reuses one credential context across all M-SF round-
          // trips. (`scoreCaseload` re-falls through to `selectSalesforceAuth`
          // when no `hydrateOptions.auth` is supplied.)
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
          // Pre-write score lives on the P1C-02 cache row this handler does
          // not touch — null here keeps the wire shape stable.
          previousScore: null,
          previousTier: null,
        };
      }
    } catch (err) {
      log.warn("barrier priority recompute failed (best-effort)", {
        event: "barrier_recompute_failed",
        reason: errorReason(err),
      });
    }
  }

  const severity = deriveResponseSeverity(validated.type, validated.severity);

  // SUCCESS audit row BEFORE response (Immutable #5). A throw here propagates
  // to the outer 500 — the success-mutation audit gate is mandatory.
  await writeAudit(db, {
    specialistId: ctx.specialistId,
    actionType: "barrier.created",
    outcome: "SUCCESS",
    participantId,
    channel: "system",
    salesforceRecordId: barrierId,
    traceId: ctx.traceId,
    payloadMetadata: {
      barrier_type: validated.type,
      severity_tier: severity ?? "unclassified",
      source: "tool",
    },
  });

  const responseBody: CreateBarrierResponseBody = {
    barrierId,
    participantId,
    type: validated.type,
    description: validated.description ?? null,
    severity,
    openedAt: now.toISOString(),
    openedBy: ctx.specialistId,
    status: "open",
    priorityRecomputed,
  };
  return createBarrierSuccessResponse(responseBody, ctx.traceId);
}
