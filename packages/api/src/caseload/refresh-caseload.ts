// POST /api/v1/caseload/refresh (endpoint E-07) — the F-16 wholesale bulk
// SOQL replay. Re-pulls the P0-08 caseload shape against Salesforce for the
// authenticated specialist, ATOMICALLY replaces every P1C-02 queue cache row
// in a single DB transaction, audits the event BEFORE the response, and
// returns the refreshed BR-20 default-queue body.
//
// Mirrors the canonical mutation composition `withSession(withIdempotency(...))`
// the P1E barrier endpoints established. Idempotency (Pattern D) is required
// per Immutable #6 — a replay inside the 24h TTL returns the stored response
// WITHOUT re-querying Salesforce. Audit (Pattern B) is committed in the same
// transaction as the cache writes per BR-75 ("Hard refresh replaces — does
// not merge — the cache. This is intentional for trust.") so a partial cache
// replacement can never escape the rollback boundary.
//
// Scope (per ticket §Scope): authenticated specialist's own caseload only.
// The §7.3.2 `?specialistId=` Supervisor/VP drill-down is deferred — passing
// it returns 422 VALIDATION_FAILED with `reason: "drill_down_not_implemented"`
// so a future P1G-follow-up flips the gate without an API surface change.
//
// Rate limit (TR-SF-9 / BR-76, P1G-02): the manual path is capped at 1 per
// 30s per specialist. The check lives inside this idempotency-wrapped core so
// a replay of a stored `Idempotency-Key` naturally bypasses it — withIdempotency
// short-circuits before the core runs, so the token is consumed only on a
// net-new request. The nightly cron (P1G-04, TR-SF-8) bypasses by calling
// `executeCaseloadRefresh` directly, NOT by smuggling a magic header through
// this handler — the rate-limit branch lives in `runRefreshCaseload` so the
// cron path remains naturally exempt.
//
// All logic lives here so it stays unit-testable without a Next runtime;
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

import { withIdempotency } from "../idempotency/middleware.js";
import type {
  IdempotentHandler,
  IdempotentRequestContext,
  WithIdempotencyOptions,
} from "../idempotency/middleware.js";
import type { IdempotencyStore } from "../idempotency/store.js";
import { rateLimitErrorResponse } from "../ratelimit/index.js";
import type { RateLimiter } from "../ratelimit/index.js";
import { withSession } from "../session/middleware.js";
import type {
  SessionHandler,
  SessionRequestContext,
  WithSessionOptions,
} from "../session/middleware.js";
import type { SessionStore } from "../session/store.js";

import { buildAllQueueBodies } from "./build-queue-bodies.js";
import { stripPiiForCache, type CaseloadBody } from "./dto.js";
import { resolveQueue } from "./queue.js";
import {
  caseloadSuccessResponse,
  internalErrorResponse,
  salesforceErrorResponse,
  validationFailedResponse,
} from "./responses.js";
import { scoreCaseload } from "./score-caseload.js";

const defaultLogger = createLogger({ module: "api.caseload.refresh" });

// Stable identifier for the SOQL shape this refresh replays. Carried on the
// audit row's `payload_metadata.soql_query_id` so analytics can correlate
// `caseload.refreshed` events with the bulk-hydration query version WITHOUT
// embedding participant ids. Bump only when the hydrate shape changes.
const REFRESH_SOQL_QUERY_ID = "score-caseload.bulk-hydrate.v1";

// Rate limit (TR-SF-9 / BR-76; API §6 E-07). 1 manual refresh per 30s per
// specialist; the namespaced scope lets other endpoints share the `rate_limits`
// table without key collisions.
const RATE_LIMIT_WINDOW_SECONDS = 30;
const RATE_LIMIT_BUDGET = 1;
const RATE_LIMIT_SCOPE = "caseload.refresh";

// The P1C-02 cache contract, structurally typed so the seams stay injectable
// (mirrors handleCaseload). `repositories.getCaseloadCache` /
// `setCaseloadCache` satisfy these.
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

// Transaction seam — defaults to `db.transaction(fn)`. Tests inject a runner
// that just calls `fn(db)` for happy-path assertions, or one that throws
// after `fn` returns for rollback assertions. Mirrors the persistence layer's
// own use of `db.transaction(async (tx) => …)`.
type TxRunner = (db: DbOrTx, fn: (tx: DbOrTx) => Promise<void>) => Promise<void>;

// The `DbOrTx` union includes the in-transaction handle, which has no
// `.transaction` of its own. Narrow through `unknown` and a runtime check so
// a future caller passing a tx handle fails loudly with a typed error instead
// of `TypeError: transaction is not a function`.
const defaultTxRunner: TxRunner = (db, fn) => {
  const candidate = db as unknown as {
    transaction?: (cb: (tx: DbOrTx) => Promise<void>) => Promise<void>;
  };
  if (typeof candidate.transaction !== "function") {
    throw new Error(
      "defaultTxRunner: handle does not expose `.transaction()`; inject `txRunner` for in-transaction callers",
    );
  }
  return candidate.transaction(fn);
};

export interface RefreshCaseloadHandlerOptions {
  // withSession seams.
  readonly store?: SessionStore;
  readonly sessionConfig?: SessionConfig;
  readonly logger?: StructuredLogger;
  // withIdempotency seam.
  readonly idempotencyStore?: IdempotencyStore;
  // M-CONFIG. Defaults to `getCalibrationConfiguration()` — the Demo-Mode live
  // config. Tests inject a fixed configuration for determinism.
  readonly configuration?: Configuration;
  // Hydration kernel seam — defaults to the live scoreCaseload (P0-08 + P1C-01).
  readonly scoreCaseloadImpl?: typeof scoreCaseload;
  // Persistence + audit + transaction seams.
  readonly db?: DbOrTx;
  readonly cacheReader?: ReadCache;
  readonly cacheWriter?: WriteCache;
  readonly writeAudit?: typeof writeAuditEntry;
  readonly txRunner?: TxRunner;
  // Rate-limit substrate (P1G-02). Defaults to the lazily-resolved Postgres
  // limiter; tests inject a fake. The seam (not the table) is the contract so
  // the Production swap to Redis is a new implementation only.
  readonly rateLimiter?: RateLimiter;
  // Server clock seam — resolved once per request so the audit row's
  // `elapsed_ms` and the engine `now` ride the same baseline.
  readonly now?: () => Date;
  // Optional override for the cache row's freshness window. Defaults to
  // `setCaseloadCache`'s built-in DEFAULT_FRESHNESS_WINDOW_SECONDS.
  readonly freshnessWindowSeconds?: number;
}

// Refresh trigger — selects the `trigger` metadata stamped on the audit
// row. "manual" = E-07 HTTP request (rate-limited); "cron" = TR-SF-8
// nightly self-heal (P1G-04, bypasses the rate limit by virtue of calling
// `executeCaseloadRefresh` directly). Both paths emit the same spec-catalog
// `caseload.refreshed` action_type (API §11.6 line 2466) — analytics
// distinguishes manual vs cron via `payload_metadata.trigger`. The ticket
// initially named `caseload.refresh.cron` but the spec catalog has no
// `caseload.*` wildcard; per spec precedence the API contract
// wins.
export type RefreshTrigger = "manual" | "cron";

// The single action_type both refresh paths emit, per API §11.6 catalog.
const REFRESH_ACTION_TYPE = "caseload.refreshed";

// Next.js App Router entry. The route shim under apps/web/ forwards `req`
// here so all logic stays runtime-independent.
export async function handleRefreshCaseload(
  req: Request,
  options: RefreshCaseloadHandlerOptions = {},
): Promise<Response> {
  const traceId = resolveTraceId(req);
  const log = (options.logger ?? defaultLogger).child({ traceId });

  // Compose withSession → withIdempotency → core. Idempotency runs after
  // session so the key is bound to the authenticated specialist (cross-
  // specialist isolation is enforced inside the middleware). `withIdempotency`
  // narrows `ctx` to `IdempotentRequestContext`; merging at the call site keeps
  // the inner handler's `ctx` correctly typed without a cast (mirrors
  // handleCreateBarrier).
  const idemOptions: WithIdempotencyOptions = {
    ...(options.idempotencyStore !== undefined
      ? { store: options.idempotencyStore }
      : {}),
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
  };

  const sessionCore: SessionHandler = (sessionReq, sessionCtx) => {
    const inner: IdempotentHandler = (idemReq, idemCtx) =>
      runRefreshCaseload(
        idemReq,
        { ...sessionCtx, ...idemCtx },
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
    log.error("caseload refresh request failed unexpectedly", {
      event: "caseload_refresh_internal_error",
      reason: errorReason(err),
    });
    return internalErrorResponse(traceId);
  }
}

// The middleware-resolved core for the MANUAL path. By this point: session is
// live, an `Idempotency-Key` UUIDv4 is held (the lock guards single execution
// per key). The cron path (P1G-04) skips this wrapper and calls
// `executeCaseloadRefresh` directly — it has no session, owns its own
// deterministic idempotency key, and must not consume the manual rate-limit
// budget.
async function runRefreshCaseload(
  req: Request,
  ctx: SessionRequestContext & IdempotentRequestContext,
  options: RefreshCaseloadHandlerOptions,
  log: StructuredLogger,
): Promise<Response> {
  // Drill-down `?specialistId=` is in §7.3.2 but deferred for this ticket.
  // 422 with a switch-friendly `reason` lets a future ticket flip the gate
  // without an API surface change.
  const url = new URL(req.url);
  if (url.searchParams.has("specialistId")) {
    return validationFailedResponse(ctx.traceId, {
      field: "specialistId",
      reason: "drill_down_not_implemented",
    });
  }

  const { db } = await resolvePersistence(options);
  const writeAudit = options.writeAudit ?? writeAuditEntry;
  const rateLimiter = await resolveRateLimiter(options.rateLimiter);

  // Rate limit (TR-SF-9 / BR-76; API §6 E-07) — 1 per 30s per specialist on
  // the manual path. Composed inside `withIdempotency` so an Idempotency-Key
  // replay short-circuits in the wrapper and never consumes a token (the
  // ticket's replay-exemption AC). The rejection audits a `caseload.refreshed`
  // FAILED row with `reason: "rate_limited"` BEFORE the 429 response
  // (Immutable #5 / Pattern B) — the audit shape mirrors `auth/refresh.ts`
  // (action_type stable across SUCCESS/FAILED, reason in payload_metadata)
  // since the audit `outcome` enum has no RATE_LIMITED member.
  //
  // The cron path (P1G-04, TR-SF-8) is system-initiated and intentionally
  // bypasses this branch by entering at `executeCaseloadRefresh` directly.
  const limit = await rateLimiter.checkAndConsume(
    `${RATE_LIMIT_SCOPE}:${ctx.specialistId}`,
    RATE_LIMIT_WINDOW_SECONDS,
  );
  if (!limit.allowed) {
    const retryAfterSeconds =
      limit.retryAfterSeconds ?? RATE_LIMIT_WINDOW_SECONDS;
    await writeAudit(db, {
      specialistId: ctx.specialistId,
      actionType: REFRESH_ACTION_TYPE,
      outcome: "FAILED",
      channel: "system",
      traceId: ctx.traceId,
      payloadMetadata: {
        trigger: "manual",
        reason: "rate_limited",
        window_seconds: RATE_LIMIT_WINDOW_SECONDS,
        retry_after_seconds: retryAfterSeconds,
      },
    });
    log.warn("caseload refresh rate limit exceeded", {
      event: "caseload_refresh_rate_limited",
    });
    return rateLimitErrorResponse(ctx.traceId, {
      retryAfterSeconds,
      limit: RATE_LIMIT_BUDGET,
    });
  }

  return executeCaseloadRefresh(ctx, options, log, "manual");
}

// The shared refresh engine: hydrate → derive → atomic commit + audit. Used
// by both the manual handler (after the rate-limit check) and the nightly
// cron worker (P1G-04, TR-SF-8). NO rate-limit check here — that branch lives
// in `runRefreshCaseload` so a cron call cannot accidentally consume the
// manual budget. The `trigger` parameter only affects the audit `action_type`
// and a `trigger` field stamped into `payloadMetadata`.
export async function executeCaseloadRefresh(
  ctx: { readonly specialistId: string; readonly traceId: string },
  options: RefreshCaseloadHandlerOptions,
  log: StructuredLogger,
  trigger: RefreshTrigger,
): Promise<Response> {
  const configuration = options.configuration ?? getCalibrationConfiguration();
  // Same Demo-stub floor as handleCaseload — the cache CHECK constraint
  // requires `config_version > 0` and the Demo stub reports version 0. A real
  // DB-backed config (positive versions) makes this a no-op.
  const configVersion = Math.max(1, configuration.version);
  const defaultQueueId = resolveQueue(null, configuration.queuePredicates)
    .queueId;

  const { db, getCache, setCache } = await resolvePersistence(options);
  const writeAudit = options.writeAudit ?? writeAuditEntry;
  const txRunner = options.txRunner ?? defaultTxRunner;
  const nowFn = options.now ?? (() => new Date());
  const actionType = REFRESH_ACTION_TYPE;

  // Best-effort pre-size capture from the existing default-queue cache row.
  // Read failure is logged-warn and the audit field falls to null — the
  // refresh itself doesn't depend on this read.
  const participantCountPre = await readPreSize(
    db,
    getCache,
    { specialistId: ctx.specialistId, queueId: defaultQueueId, configVersion },
    log,
  );

  const startedAt = Date.now();
  const elapsedMs = (): number => Date.now() - startedAt;

  // --- Bulk SOQL replay -----------------------------------------------------
  // A SalesforceError here is a real mutation-attempt failure: the request was
  // validated and is about to mutate the cache, so it audits as a
  // FAILED row BEFORE the SF error response (Immutable #5).
  let scored: Awaited<ReturnType<typeof scoreCaseload>>["scored"];
  let roundTrips: number;
  let scoredNow: Date;
  try {
    const result = await (options.scoreCaseloadImpl ?? scoreCaseload)(
      ctx.specialistId,
      { configuration, now: nowFn, logger: log },
    );
    scored = result.scored;
    roundTrips = result.roundTrips;
    scoredNow = result.now;
  } catch (err) {
    if (err instanceof SalesforceError) {
      await writeAudit(db, {
        specialistId: ctx.specialistId,
        actionType,
        outcome: "FAILED",
        channel: "system",
        traceId: ctx.traceId,
        payloadMetadata: {
          trigger,
          soql_query_id: REFRESH_SOQL_QUERY_ID,
          failure_phase: "hydrate",
          sf_code: err.code,
          elapsed_ms: elapsedMs(),
        },
      });
      log.error("caseload refresh hydration failed", {
        event: "caseload_refresh_sf_error",
        sf_code: err.code,
        reason: err.message,
      });
      return salesforceErrorResponse(err, ctx.traceId);
    }
    throw err;
  }

  // --- Pure derivation ------------------------------------------------------
  const { bodies, queueCounts } = buildAllQueueBodies({
    scored,
    configuration,
    specialistId: ctx.specialistId,
    configVersion,
    now: scoredNow,
  });

  const responseBody = bodies.get(defaultQueueId);
  if (responseBody === undefined) {
    // Unreachable — `defaultQueueId` came from the same universe just iterated.
    throw new Error(
      `internal: default queue '${defaultQueueId}' absent from built bodies`,
    );
  }

  // --- Atomic commit (BR-75) ------------------------------------------------
  // Audit row + every queue's cache row commit (or roll back) together. The
  // audit row is INSERTed FIRST inside the TX so a SUCCESS row whose claimed
  // `participant_count_post` was never durably cached can never exist. On TX
  // throw, the outer catch returns 500; the manual path's `withIdempotency`
  // releases the key on 5xx so a client retry can succeed.
  try {
    await txRunner(db, async (tx) => {
      await writeAudit(tx, {
        specialistId: ctx.specialistId,
        actionType,
        outcome: "SUCCESS",
        channel: "system",
        traceId: ctx.traceId,
        payloadMetadata: {
          trigger,
          soql_query_id: REFRESH_SOQL_QUERY_ID,
          participant_count_pre: participantCountPre,
          participant_count_post: scored.length,
          queue_counts: queueCounts,
          config_version: configVersion,
          round_trips: roundTrips,
          elapsed_ms: elapsedMs(),
        },
      });
      for (const [queueId, body] of bodies) {
        // P1H-01: strip PII (displayName) before persisting — Immutable #1 +
        // caseload-cache.ts PII contract. The wire response below still holds
        // the unstripped body.
        await setCache(tx, {
          specialistId: ctx.specialistId,
          queueId,
          configVersion,
          payload: stripPiiForCache(body),
          ...(options.freshnessWindowSeconds !== undefined
            ? { freshnessWindowSeconds: options.freshnessWindowSeconds }
            : {}),
        });
      }
    });
  } catch (err) {
    // No partial state escapes the rollback. Log loud (don't catch
    // errors silently) and surface a 500; withIdempotency releases the key.
    log.error("caseload refresh persistence transaction failed", {
      event: "caseload_refresh_persist_error",
      reason: errorReason(err),
    });
    return internalErrorResponse(ctx.traceId);
  }

  return caseloadSuccessResponse(responseBody, ctx.traceId);
}

// Best-effort read of the existing default-queue cache row's participant count
// for the audit row's `participant_count_pre`. A miss → null; a read failure
// is logged-warn and also returns null — the refresh itself doesn't depend on
// this read, so a transient cache error must not fail the request.
async function readPreSize(
  db: DbOrTx,
  getCache: ReadCache,
  key: CaseloadCacheKey,
  log: StructuredLogger,
): Promise<number | null> {
  try {
    const cached = await getCache(db, key);
    if (cached.payload === null) return null;
    return cached.payload.items.length;
  } catch (err) {
    log.warn("caseload refresh pre-size capture failed (best-effort)", {
      event: "caseload_refresh_presize_failed",
      reason: errorReason(err),
    });
    return null;
  }
}

// Lazily-resolved, memoized default Postgres rate limiter (P1G-02). The
// dynamic import keeps the @anthos/persistence connection side effect out of
// @anthos/api's static import graph (mirrors resolvePersistence and the auth
// refresh handler). Tests inject `options.rateLimiter` so this is never
// reached.
let defaultRateLimiterPromise: Promise<RateLimiter> | undefined;

async function resolveRateLimiter(
  injected: RateLimiter | undefined,
): Promise<RateLimiter> {
  if (injected !== undefined) {
    return injected;
  }
  defaultRateLimiterPromise ??= import("../ratelimit/postgres-store.js").then(
    (m) => m.createDefaultPostgresRateLimiter(),
  );
  return defaultRateLimiterPromise;
}

// Resolves the DB + cache seams. Defaults dynamic-import `@anthos/persistence`
// so the DB connection side effect stays out of @anthos/api's static import
// graph (mirrors handleCaseload). Tests inject all three so this is never
// reached.
async function resolvePersistence(
  options: RefreshCaseloadHandlerOptions,
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

function errorReason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
