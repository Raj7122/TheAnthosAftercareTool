// Pattern D — BFF idempotency middleware (TR-WRITE-2, ARC-09, API §8.4).
//
// `withIdempotency` wraps a mutating route handler. It requires an
// `Idempotency-Key` header, acquires an atomic lock, runs the handler at most
// once per key, and resolves duplicates via the three-state machine
// IN_FLIGHT → COMPLETED | FAILED_TERMINAL with a 24h TTL.
//
// Audit: the middleware never writes to audit_log. Audit-before-response is a
// transactional invariant the handler owns (mutation + audit row committed
// together). The middleware's only audit-related guarantee is that a replay
// returns the cached response WITHOUT re-running the handler — so the handler's
// audit row is written exactly once per key.

import { createLogger, resolveTraceId } from "@anthos/logging";
import type { StructuredLogger } from "@anthos/logging";

import { computeRequestHash } from "./request-hash.js";
import { cachedReplayResponse, idempotencyErrorResponse } from "./responses.js";
import type { AcquireLockInput, IdempotencyRecord, IdempotencyStore } from "./store.js";

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const MAX_ENDPOINT_LENGTH = 200;

// The idempotency-key prefix length carried in rejection logs. A short prefix
// disambiguates the key for debugging while staying clear of the PII firewall's
// value heuristics; the full key lives on the idempotency_keys row.
const KEY_LOG_PREFIX_LENGTH = 8;

// Structured logger for this middleware (@anthos/logging — P1A-06). Per request
// a child binds trace_id + specialist_id.
const defaultLogger = createLogger({ module: "api.idempotency" });

// Context the caller (post-authentication) supplies. `specialistId` comes from
// the session layer (P1A-04).
export interface RequestContext {
  readonly specialistId: string;
}

// Context the middleware passes down to the wrapped handler. `traceId` lets the
// handler propagate the inbound correlation id into its own audit row and any
// downstream call.
export interface IdempotentRequestContext extends RequestContext {
  readonly traceId: string;
  readonly idempotencyKey: string;
}

export type IdempotentHandler = (
  req: Request,
  ctx: IdempotentRequestContext,
) => Promise<Response>;

export interface WithIdempotencyOptions {
  // Injectable store — defaults to the Demo-Mode Postgres store, resolved
  // lazily so the DB connection side effect stays out of the static import
  // graph. Tests inject an in-memory fake.
  readonly store?: IdempotencyStore;
  // Injectable structured logger — defaults to the `api.idempotency` logger.
  // Tests inject a spy to assert on rejection events.
  readonly logger?: StructuredLogger;
}

// Lazily resolved, memoized default store. The dynamic import keeps the DB
// connection side effect out of the static import graph of @anthos/api. This
// promise is a process-scoped singleton — tests MUST inject `options.store` so
// the default (DB-backed) path is never reached.
let defaultStorePromise: Promise<IdempotencyStore> | undefined;

async function resolveDefaultStore(): Promise<IdempotencyStore> {
  defaultStorePromise ??= import("./postgres-store.js").then((m) =>
    m.createDefaultPostgresStore(),
  );
  return defaultStorePromise;
}

function parseBodyOrNull(text: string): unknown {
  if (text.length === 0) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function withTraceHeader(res: Response, traceId: string, bodyText: string): Response {
  const headers = new Headers(res.headers);
  headers.set("X-Trace-Id", traceId);
  // Mutating-endpoint responses must never be cached (API §7.1.1).
  headers.set("Cache-Control", "no-store");
  return new Response(bodyText.length > 0 ? bodyText : null, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

// Structured log for a middleware-level rejection that fires before any
// handler runs. ERD §6.2 requires the request-hash-mismatch rejection be
// "audited"; P1A-06 resolved this — a rejected request mutates nothing, so it
// is recorded on the structured log stream (carrying trace_id), NOT written to
// audit_log: no handler runs, so the handler-owns-audit invariant is intact.
// `log` already binds trace_id + specialist_id; the payload is correlation IDs
// only — no PII.
function logRejection(
  log: StructuredLogger,
  event: string,
  input: AcquireLockInput,
): void {
  log.warn(`idempotency middleware rejection: ${event}`, {
    event,
    idempotency_key_prefix: input.key.slice(0, KEY_LOG_PREFIX_LENGTH),
  });
}

// Resolves a duplicate request against the existing row. Cross-specialist
// isolation is checked FIRST and never returns the cached body — one
// specialist must never receive another's response.
function resolveConflictResponse(
  existing: IdempotencyRecord,
  input: AcquireLockInput,
  traceId: string,
  log: StructuredLogger,
): Response {
  if (existing.specialistId !== input.specialistId) {
    // A UUIDv4 collision across specialists is astronomically unlikely; log it
    // as an anomaly. 409 (never the cached body) — never leak another's response.
    logRejection(log, "idempotency_cross_specialist_collision", input);
    return idempotencyErrorResponse("IDEMPOTENCY_IN_FLIGHT", traceId);
  }
  // A null stored hash (e.g. a row written before request-hash binding) cannot
  // be compared — skip the check rather than mis-report a 422.
  if (
    existing.requestHash !== null &&
    existing.requestHash !== input.requestHash
  ) {
    // ERD §6.2 mandates this rejection be "audited". P1A-06 resolved the
    // interpretation: the structured log stream (carrying trace_id) satisfies
    // it — a rejected request is not a state mutation, so no audit_log row is
    // written from the middleware. See logRejection.
    logRejection(log, "idempotency_request_hash_mismatch", input);
    return idempotencyErrorResponse(
      "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD",
      traceId,
    );
  }
  switch (existing.status) {
    case "IN_FLIGHT":
      return idempotencyErrorResponse("IDEMPOTENCY_IN_FLIGHT", traceId);
    case "COMPLETED":
    case "FAILED_TERMINAL":
      return cachedReplayResponse(existing, traceId);
  }
}

type AcquireOutcome =
  | { readonly held: true }
  | { readonly held: false; readonly response: Response };

// Atomic lock-acquire with duplicate resolution. A row that has passed its TTL
// but has not yet been swept by the cleanup cron is evicted and the key is
// re-acquired fresh (API §8.4: after expiry the key may be reused).
async function acquireOrResolve(
  store: IdempotencyStore,
  input: AcquireLockInput,
  traceId: string,
  log: StructuredLogger,
): Promise<AcquireOutcome> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const acquired = await store.acquire(input);
    if (acquired !== null) {
      return { held: true };
    }
    const existing = await store.get(input.key);
    if (existing === null) {
      continue; // row vanished between acquire and get — retry once
    }
    if (existing.expiresAt.getTime() <= Date.now()) {
      await store.delete(input.key); // stale — evict and retry
      continue;
    }
    return {
      held: false,
      response: resolveConflictResponse(existing, input, traceId, log),
    };
  }
  // Both attempts lost the race without a resolvable row — treat as in-flight.
  return {
    held: false,
    response: idempotencyErrorResponse("IDEMPOTENCY_IN_FLIGHT", traceId),
  };
}

export function withIdempotency(
  handler: IdempotentHandler,
  options: WithIdempotencyOptions = {},
): (req: Request, ctx: RequestContext) => Promise<Response> {
  return async (req, ctx) => {
    const traceId = resolveTraceId(req);
    const log = (options.logger ?? defaultLogger).child({
      traceId,
      specialistId: ctx.specialistId,
    });
    const store = options.store ?? (await resolveDefaultStore());

    const key = req.headers.get("Idempotency-Key");
    if (key === null || key.length === 0) {
      return idempotencyErrorResponse("IDEMPOTENCY_KEY_REQUIRED", traceId);
    }
    if (!UUID_V4.test(key)) {
      return idempotencyErrorResponse("IDEMPOTENCY_KEY_INVALID", traceId);
    }

    const url = new URL(req.url);
    const endpoint = `${req.method} ${url.pathname}`.slice(0, MAX_ENDPOINT_LENGTH);
    const bodyText = await req.clone().text();
    const requestHash = computeRequestHash(req.method, url.pathname, bodyText);
    const lockInput: AcquireLockInput = {
      key,
      specialistId: ctx.specialistId,
      endpoint,
      requestHash,
      traceId,
    };

    const outcome = await acquireOrResolve(store, lockInput, traceId, log);
    if (!outcome.held) {
      return outcome.response;
    }

    // The lock is held — run the handler exactly once.
    try {
      const res = await handler(req, { ...ctx, traceId, idempotencyKey: key });
      const responseText = await res.clone().text();
      const responseBody = parseBodyOrNull(responseText);

      if (res.status >= 200 && res.status < 400) {
        await store.markCompleted(key, res.status, responseBody);
      } else if (res.status >= 400 && res.status < 500) {
        // 4xx is terminal — cache the failure, no retry on replay (TR-WRITE-2b).
        await store.markFailedTerminal(key, res.status, responseBody);
      } else {
        // 5xx / network — release the lock so the client or offline queue can
        // safely retry (TR-WRITE-2b).
        await store.delete(key);
      }
      return withTraceHeader(res, traceId, responseText);
    } catch (err) {
      // Thrown / network failure — release the lock and surface the error.
      await store.delete(key);
      throw err;
    }
  };
}
