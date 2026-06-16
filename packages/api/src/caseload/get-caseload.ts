// GET /api/v1/caseload?queue=X (endpoint E-06) — the SPA's primary read
// (F-02 caseload + F-04 queues). Bulk-hydrates the caller's caseload from
// Salesforce (P0-08), scores it with the priority engine (P0-03..P0-08),
// resolves the queue predicate from M-CONFIG (BR-22), filters + sorts within
// the queue (BR-21), and returns the shaped E-06 body — served warm from the
// P1C-02 cache when fresh, hydrated + written through on a cold miss.
//
// Auth: `withSession` (P1A-04) owns the gate — the core runs only for a live
// session, and the caseload is scored for `ctx.specialistId` (the caller's
// own). Supervisor/VP `?specialistId=` drill-down and non-priority `?sort=`
// are out of scope for P1C-01 (BR-21 fixes the sort to priority-desc).
//
// Audit: a `caseload.hydrated` Pattern B row is written BEFORE the response on
// the COLD path only (API §6.2 — a warm read is a pure read, not a state
// mutation; Immutable #5 governs mutations). No `Idempotency-Key` (read).
//
// All logic lives here so it is unit-testable without a Next runtime;
// `apps/web` carries only a thin route shim.

import { writeAuditEntry } from "@anthos/audit";
import {
  getCalibrationConfiguration,
  type Configuration,
} from "@anthos/domain";
import { SalesforceError } from "@anthos/integrations";
import { createLogger, resolveTraceId } from "@anthos/logging";
import type { StructuredLogger } from "@anthos/logging";
import type { DbOrTx } from "@anthos/persistence";
import type { SessionConfig } from "@anthos/auth";

import { withSession } from "../session/middleware.js";
import type {
  SessionHandler,
  SessionRequestContext,
  WithSessionOptions,
} from "../session/middleware.js";
import type { SessionStore } from "../session/store.js";
import { buildAllQueueBodies } from "./build-queue-bodies.js";
import { stripPiiForCache, type CaseloadBody } from "./dto.js";
import { hydrateDisplayNames } from "./hydrate-display-names.js";
import { resolveQueue, UnknownQueueError } from "./queue.js";
import {
  caseloadSuccessResponse,
  internalErrorResponse,
  queueNotFoundResponse,
  salesforceErrorResponse,
} from "./responses.js";
import { scoreCaseload, type ScoredParticipant } from "./score-caseload.js";

const defaultLogger = createLogger({ module: "api.caseload" });

// The P1C-02 cache contract, structurally typed so the seam is injectable.
// `repositories.getCaseloadCache` / `setCaseloadCache` satisfy these.
type CacheFreshness = "fresh" | "stale" | "miss";

interface CaseloadCacheKey {
  readonly specialistId: string;
  readonly queueId: string;
  readonly configVersion: number;
}

interface CacheReadResult {
  readonly freshness: CacheFreshness;
  readonly payload: CaseloadBody | null;
  readonly lastRefreshedAt: Date | null;
}

type ReadCache = (db: DbOrTx, key: CaseloadCacheKey) => Promise<CacheReadResult>;
type WriteCache = (
  db: DbOrTx,
  input: CaseloadCacheKey & {
    payload: CaseloadBody;
    freshnessWindowSeconds?: number;
  },
) => Promise<void>;

export interface CaseloadHandlerOptions {
  // withSession seams — defaults resolve inside withSession.
  readonly store?: SessionStore;
  readonly sessionConfig?: SessionConfig;
  readonly logger?: StructuredLogger;
  // M-CONFIG. Defaults to `getCalibrationConfiguration()` — the Demo-Mode live
  // config; no DB-backed active `configuration` row is seeded yet (the swap to
  // `getActiveConfiguration(db)` is a one-line change here once it is).
  readonly configuration?: Configuration;
  // Test seams — default to the live kernel / persistence repositories / audit.
  readonly scoreCaseloadImpl?: typeof scoreCaseload;
  readonly db?: DbOrTx;
  readonly cacheReader?: ReadCache;
  readonly cacheWriter?: WriteCache;
  readonly writeAudit?: typeof writeAuditEntry;
  readonly now?: () => Date;
  readonly freshnessWindowSeconds?: number;
  // P1H-13a — re-attaches `displayName` on warm-cache reads (the cache strips
  // PII per Immutable #1). Defaults to the live in-memory + SF backfill
  // implementation; tests inject a fake.
  readonly hydrateDisplayNamesImpl?: typeof hydrateDisplayNames;
}

// The full E-06 handler. `withSession` owns the auth gate; a safety net
// converts an unexpected throw into a structured 500 rather than letting it
// escape to the Next runtime.
export async function handleCaseload(
  req: Request,
  options: CaseloadHandlerOptions = {},
): Promise<Response> {
  const traceId = resolveTraceId(req);
  const log = (options.logger ?? defaultLogger).child({ traceId });

  const core: SessionHandler = (sessionReq, ctx) =>
    runCaseload(sessionReq, ctx, options, log);

  // exactOptionalPropertyTypes forbids an explicit `undefined` — spread each
  // injected seam only when supplied (mirrors handleMe).
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
    // No silent catch. withSession's own 401s return directly;
    // reaching here is an unexpected fault — a 500, never a 401.
    log.error("caseload request failed unexpectedly", {
      event: "caseload_internal_error",
      reason: errorReason(err),
    });
    return internalErrorResponse(traceId);
  }
}

// The session-resolved core: resolve queue → warm-cache read → cold hydrate.
async function runCaseload(
  req: Request,
  ctx: SessionRequestContext,
  options: CaseloadHandlerOptions,
  log: StructuredLogger,
): Promise<Response> {
  const configuration = options.configuration ?? getCalibrationConfiguration();
  // The cache key's `config_version` AND the response's `configurationVersion`.
  // `caseload_cache.config_version` has a `> 0` CHECK (P1C-02), and a valid
  // Configuration has a positive `version` (`configurationSchema`). The Demo
  // stub `getCalibrationConfiguration()` reports version 0, so it is floored to
  // 1 — a real DB-backed config (positive versions) makes this a no-op.
  // Flagged in the PR: the stub's version-0 vs the cache `> 0` CHECK.
  const configVersion = Math.max(1, configuration.version);

  // Resolve the requested queue from M-CONFIG (BR-22). Unknown id → 404.
  const queueParam = new URL(req.url).searchParams.get("queue");
  let queueId: string;
  try {
    queueId = resolveQueue(queueParam, configuration.queuePredicates).queueId;
  } catch (err) {
    if (err instanceof UnknownQueueError) {
      log.warn("caseload request for an unknown queue", {
        event: "caseload_unknown_queue",
        queue_id: err.queueId,
      });
      return queueNotFoundResponse(ctx.traceId);
    }
    // QueueConfigurationError (misconfigured universe) / unexpected — 500.
    throw err;
  }

  const { db, getCache, setCache } = await resolvePersistence(options);
  const writeAudit = options.writeAudit ?? writeAuditEntry;
  const nowFn = options.now ?? (() => new Date());

  // --- Warm path — a fresh cache row is returned with no SF call, no audit.
  const cached = await getCache(db, {
    specialistId: ctx.specialistId,
    queueId,
    configVersion,
  });
  if (
    cached.freshness === "fresh" &&
    cached.payload !== null &&
    cached.lastRefreshedAt !== null
  ) {
    // P1H-13a — re-attach `displayName` (stripped from the cache per
    // Immutable #1). A failure here is logged and degrades to the SPA's
    // participantId fallback; it must NOT 500 — the score data is fresh.
    const hydrate = options.hydrateDisplayNamesImpl ?? hydrateDisplayNames;
    let hydratedPayload = cached.payload;
    try {
      hydratedPayload = await hydrate(cached.payload);
    } catch (err) {
      log.warn("displayName hydration failed; serving cache as-is", {
        event: "caseload_displayname_hydration_failed",
        reason: errorReason(err),
      });
    }
    return caseloadSuccessResponse(
      {
        ...hydratedPayload,
        cacheAgeSeconds: secondsBetween(cached.lastRefreshedAt, nowFn()),
      },
      ctx.traceId,
    );
  }

  // --- Cold path — `stale` and `miss` both rehydrate (P1C-03 CDC
  // invalidation is not built yet, so a stale row's age is unbounded).
  let scored: ReadonlyArray<ScoredParticipant>;
  let roundTrips: number;
  let now: Date;
  try {
    const result = await (options.scoreCaseloadImpl ?? scoreCaseload)(
      ctx.specialistId,
      { configuration, now: nowFn, logger: log },
    );
    scored = result.scored;
    roundTrips = result.roundTrips;
    now = result.now;
  } catch (err) {
    if (err instanceof SalesforceError) {
      log.error("caseload hydration failed", {
        event: "caseload_sf_error",
        sf_code: err.code,
        reason: err.message,
      });
      return salesforceErrorResponse(err, ctx.traceId);
    }
    throw err;
  }

  // Pure-derivation pass — assemble every queue's body and the cross-queue
  // counts. Shared with the refresh handler so membership / BR-21 sort /
  // cache-payload shape can never drift between GET and POST /refresh.
  const { bodies: bodiesByQueue, queueCounts } = buildAllQueueBodies({
    scored,
    configuration,
    specialistId: ctx.specialistId,
    configVersion,
    now,
  });

  const requestedBody = bodiesByQueue.get(queueId);
  if (requestedBody === undefined) {
    // Unreachable — `queueId` came from the same universe just iterated.
    throw new Error(
      `internal: requested queue '${queueId}' absent from built bodies`,
    );
  }

  // Pattern B / Immutable #5 — audit row BEFORE the response (cold path only).
  // No participant PII in `payload_metadata`: kebab queue ids + counts only.
  // A throw here propagates to the outer catch (500) — no fire-and-forget.
  await writeAudit(db, {
    specialistId: ctx.specialistId,
    actionType: "caseload.hydrated",
    outcome: "SUCCESS",
    channel: "system",
    traceId: ctx.traceId,
    payloadMetadata: {
      queue_id: queueId,
      config_version: configVersion,
      round_trips: roundTrips,
      participant_count: scored.length,
      degraded_count: scored.filter((participant) => participant.degraded)
        .length,
      queue_counts: queueCounts,
    },
  });

  // Write-through — best effort. A failed cache write degrades NFR-PERF-1
  // (the next read re-hydrates) but the response is already correct, so it is
  // logged, not surfaced as a 500. Logged, never silently swallowed.
  try {
    for (const [id, body] of bodiesByQueue) {
      // P1H-01: strip PII (displayName) before persisting — Immutable #1 +
      // caseload-cache.ts PII contract. The wire response below still holds
      // the unstripped body.
      await setCache(db, {
        specialistId: ctx.specialistId,
        queueId: id,
        configVersion,
        payload: stripPiiForCache(body),
        ...(options.freshnessWindowSeconds !== undefined
          ? { freshnessWindowSeconds: options.freshnessWindowSeconds }
          : {}),
      });
    }
  } catch (err) {
    log.warn("caseload cache write-through failed", {
      event: "caseload_cache_write_failed",
      reason: errorReason(err),
    });
  }

  return caseloadSuccessResponse(requestedBody, ctx.traceId);
}

// Resolves the DB + cache seams. Defaults dynamic-import `@anthos/persistence`
// so the DB connection side effect stays out of @anthos/api's static import
// graph (mirrors handleMe). Tests inject all three so this is never reached.
async function resolvePersistence(
  options: CaseloadHandlerOptions,
): Promise<{ db: DbOrTx; getCache: ReadCache; setCache: WriteCache }> {
  const { db, cacheReader, cacheWriter } = options;
  if (
    db !== undefined &&
    cacheReader !== undefined &&
    cacheWriter !== undefined
  ) {
    return { db, getCache: cacheReader, setCache: cacheWriter };
  }
  const persistence = await import("@anthos/persistence");
  return {
    db: db ?? persistence.db,
    getCache:
      cacheReader ??
      ((dbArg, key) =>
        persistence.repositories.getCaseloadCache<CaseloadBody>(dbArg, key)),
    setCache:
      cacheWriter ??
      ((dbArg, input) => persistence.repositories.setCaseloadCache(dbArg, input)),
  };
}

// Whole seconds between two instants, floored, never negative — a clock skew
// must not surface a negative `cacheAgeSeconds`.
function secondsBetween(from: Date, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / 1000));
}

function errorReason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
