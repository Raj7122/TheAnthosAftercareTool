// GET /api/v1/participants/:id (endpoint E-08) — the F-07 participant detail
// read. Composes `withSession` (P1A-04) → SF identity hydration → authz gate
// (VR-15) → engine scoring via `scoreCaseload` → wire DTO assembly, with a
// Pattern B audit row written BEFORE the response per Immutable #5.
//
// Auth: `withSession` owns session resolution; this handler enforces VR-15
// scope (SPECIALIST own / SUPERVISOR supervised-stub / VP any / SYSTEM_ADMIN
// denied) — mirrors `handleCreateBarrier`'s authz approach.
//
// Audit: a `participant.detail_viewed` row is written on EVERY outcome
// (SUCCESS, FAILED). The ticket §Scope is explicit ("Emits a Pattern B audit-
// log row BEFORE returning per Immutable #5") — unlike `handleCaseload` which
// only audits on the cold path, E-08 audits unconditionally so the detail-
// view access trail is complete for SEC-AUDIT-3 / BR-40 review.
//
// All logic lives here so it stays unit-testable without a Next runtime;
// `apps/web` carries only a thin route shim.

import type { Role, SessionConfig } from "@anthos/auth";
import { writeAuditEntry } from "@anthos/audit";
import {
  SalesforceError,
  SalesforceRestClient,
  assertSalesforceId,
  type SalesforceAuth,
} from "@anthos/integrations";
import {
  getCalibrationConfiguration,
  type Configuration,
} from "@anthos/domain";
import { createLogger, resolveTraceId } from "@anthos/logging";
import type { StructuredLogger } from "@anthos/logging";
import type { DbOrTx } from "@anthos/persistence";

import { scoreCaseload } from "../caseload/score-caseload.js";
import { selectSalesforceAuth } from "../salesforce/select-auth.js";
import { withSession } from "../session/middleware.js";
import type {
  SessionHandler,
  SessionRequestContext,
  WithSessionOptions,
} from "../session/middleware.js";
import type { SessionStore } from "../session/store.js";

import { checkAuthz } from "./authz.js";
import { buildParticipantDetailBody } from "./dto.js";
import {
  hydrateParticipantIdentity,
  type ParticipantIdentity,
} from "./identity-hydration.js";
import {
  internalErrorResponse,
  participantDetailSuccessResponse,
  participantNotFoundResponse,
  salesforceErrorResponse,
  validationFailedResponse,
} from "./responses.js";

const defaultLogger = createLogger({ module: "api.participants.detail" });

export type RouteContext = {
  readonly params: Promise<{ id: string }> | { id: string };
};

export interface GetParticipantHandlerOptions {
  // withSession seams.
  readonly store?: SessionStore;
  readonly sessionConfig?: SessionConfig;
  readonly logger?: StructuredLogger;
  // M-CONFIG (must agree with the scoring kernel — pass the same instance to
  // both seams). Defaults to `getCalibrationConfiguration()`.
  readonly configuration?: Configuration;
  // M-SF seams. `restClient` overrides both auth and round-trip metering;
  // `salesforceAuth` lets a test swap only the credential path.
  readonly restClient?: SalesforceRestClient;
  readonly salesforceAuth?: SalesforceAuth;
  // Persistence + audit seams.
  readonly db?: DbOrTx;
  readonly writeAudit?: typeof writeAuditEntry;
  // Scoring seam — defaults to the live `scoreCaseload` kernel.
  readonly scoreCaseloadImpl?: typeof scoreCaseload;
  // Identity-hydration seam — defaults to the live SOQL path. Tests inject
  // either a custom rest client (above) or this directly.
  readonly hydrateIdentityImpl?: typeof hydrateParticipantIdentity;
  // Server clock seam — resolved once per request so audit + day-deltas +
  // engine scoring align against an identical instant.
  readonly now?: () => Date;
}

// Next.js App Router entry. The route shim under `apps/web/` forwards `req`
// and the dynamic route context here so all logic stays runtime-independent.
export async function handleGetParticipant(
  req: Request,
  routeCtx: RouteContext,
  options: GetParticipantHandlerOptions = {},
): Promise<Response> {
  const traceId = resolveTraceId(req);
  const log = (options.logger ?? defaultLogger).child({ traceId });

  let participantId: string;
  try {
    const params = await Promise.resolve(routeCtx.params);
    participantId = params.id;
  } catch (err) {
    log.error("get-participant route params resolution failed", {
      event: "participant_detail_params_error",
      reason: errorReason(err),
    });
    return internalErrorResponse(traceId);
  }

  const core: SessionHandler = (sessionReq, ctx) =>
    runGetParticipant(sessionReq, ctx, participantId, options, log);

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
    log.error("get-participant request failed unexpectedly", {
      event: "participant_detail_internal_error",
      reason: errorReason(err),
    });
    return internalErrorResponse(traceId);
  }
}

// The session-resolved core. By this point: session is live, role is known.
async function runGetParticipant(
  req: Request,
  ctx: SessionRequestContext,
  participantId: string,
  options: GetParticipantHandlerOptions,
  log: StructuredLogger,
): Promise<Response> {
  // Shape-validate the path param. A non-Salesforce-Id-shaped value is a 422,
  // not a 404 — the URL is malformed.
  try {
    assertSalesforceId(participantId, "participantId");
  } catch {
    return validationFailedResponse(ctx.traceId, {
      field: "participantId",
      reason: "invalid_salesforce_id",
    });
  }

  const configuration =
    options.configuration ?? getCalibrationConfiguration();
  const auth = options.salesforceAuth ?? selectSalesforceAuth();
  const restClient = options.restClient ?? new SalesforceRestClient({ auth });
  const db = await resolveDb(options.db);
  const writeAudit = options.writeAudit ?? writeAuditEntry;
  const nowFn = options.now ?? (() => new Date());
  const now = nowFn();
  const hydrateIdentity =
    options.hydrateIdentityImpl ?? hydrateParticipantIdentity;

  // ── Phase 1: identity hydration + 404 short-circuit ────────────────────────
  let identity: ParticipantIdentity | null;
  try {
    identity = await hydrateIdentity(participantId, { restClient });
  } catch (err) {
    if (err instanceof SalesforceError) {
      await writeAudit(db, {
        specialistId: ctx.specialistId,
        actionType: "participant.detail_viewed",
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
      log.error("participant identity lookup failed", {
        event: "participant_detail_sf_error",
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

  // ── Phase 2: VR-15 authz gate ─────────────────────────────────────────────
  // SPECIALIST: owner must equal caller. SUPERVISOR: 403 stub (no supervisor→
  // supervised mapping yet — same posture as create-barrier). VP: any.
  // SYSTEM_ADMIN: never permitted at F-07.
  const authzDenied = checkAuthz(ctx.role, ctx.specialistId, identity);
  if (authzDenied !== null) return authzDenied(ctx.traceId);

  // ── Phase 3: engine scoring via the participant's caseload ────────────────
  // Score the OWNER's caseload (not the caller's) so the engine result is
  // correct regardless of caller role. `aftercareOwnerId` is non-null after
  // the SPECIALIST authz check; for VP we tolerate `null` by treating the row
  // as soft-degraded (engine=null).
  const ownerId = identity.aftercareOwnerId;
  let scoredSnapshot: ScoredRow | null = null;
  if (ownerId !== null) {
    try {
      const scoring = await (options.scoreCaseloadImpl ?? scoreCaseload)(
        ownerId,
        {
          configuration,
          now: () => now,
          logger: log,
          // Reuse the same auth instance so the round-trip count is metered
          // off one credential context.
          hydrateOptions: { auth },
        },
      );
      const match = scoring.scored.find(
        (p) => p.snapshot.participantId === participantId,
      );
      if (match !== undefined) {
        scoredSnapshot = {
          snapshot: match.snapshot,
          engine: match.engine,
        };
      } else {
        // PE owner mid-flight reassignment, or the row was filtered out of
        // the caseload bound (Inactive__c=true / withdrawal date set) between
        // the identity read and the caseload hydrate. The detail view still
        // renders — the body carries `dataIssues: ["score_unresolved"]`.
        log.warn("participant detail: PE present but absent from owner caseload", {
          event: "participant_detail_score_unresolved",
          owner_id_present: ownerId !== null,
        });
      }
    } catch (err) {
      if (err instanceof SalesforceError) {
        await writeAudit(db, {
          specialistId: ctx.specialistId,
          actionType: "participant.detail_viewed",
          outcome: "FAILED",
          participantId,
          channel: "system",
          traceId: ctx.traceId,
          payloadMetadata: {
            sf_code: err.code,
            failure_phase: "scoring",
            role: ctx.role,
          },
        });
        log.error("participant detail scoring failed", {
          event: "participant_detail_score_sf_error",
          sf_code: err.code,
          reason: err.message,
        });
        return salesforceErrorResponse(err, ctx.traceId);
      }
      throw err;
    }
  }

  // ── Phase 4: build the wire body ──────────────────────────────────────────
  const body = buildParticipantDetailBody({
    identity,
    snapshot: scoredSnapshot?.snapshot ?? null,
    engine: scoredSnapshot?.engine ?? null,
    configuration,
    role: ctx.role,
    now,
  });

  // ── Phase 5: SUCCESS audit row BEFORE response (Immutable #5) ─────────────
  // Participant id rides the dedicated column (not `payload_metadata`). The
  // metadata block carries derived counts only — no PII, no identity fields.
  await writeAudit(db, {
    specialistId: ctx.specialistId,
    actionType: "participant.detail_viewed",
    outcome: "SUCCESS",
    participantId,
    channel: "system",
    traceId: ctx.traceId,
    payloadMetadata: {
      role: ctx.role,
      role_view_mode: roleViewMode(ctx.role),
      factor_count: body.factors.length,
      triggered_invariant_count: body.triggered_invariants.length,
      open_barrier_count: body.openBarriers.length,
      score_unresolved: scoredSnapshot === null,
    },
  });

  return participantDetailSuccessResponse(body, ctx.traceId);
}

interface ScoredRow {
  readonly snapshot: import("@anthos/integrations").CaseloadSnapshot;
  readonly engine: import("@anthos/domain").EngineOutput | null;
}

// Derived field on the audit row: which UX mode the caller experiences. The
// SPA reads `quickActions` directly, but the audit ledger benefits from a
// stable label that does not depend on the response shape evolving.
function roleViewMode(role: Role): "read_only" | "write" {
  return role === "SUPERVISOR" || role === "SYSTEM_ADMIN" ? "read_only" : "write";
}

// Resolves the DB seam. Defaults dynamic-import `@anthos/persistence` so the DB
// connection side effect stays out of the static import graph (mirrors
// `handleCreateBarrier`). Tests inject `options.db` so the default is never hit.
let defaultDbPromise: Promise<DbOrTx> | undefined;
async function resolveDb(injected: DbOrTx | undefined): Promise<DbOrTx> {
  if (injected !== undefined) return injected;
  defaultDbPromise ??= import("@anthos/persistence").then((m) => m.db);
  return defaultDbPromise;
}

function errorReason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
