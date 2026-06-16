// caseload_cache repository — the Demo-Mode server-side cache for engine-scored
// caseload payloads (P1C-02; F-02, F-04). The warm-path caseload read hits one
// `get` here instead of re-running the bulk Salesforce SOQL hydrate + the
// priority-engine pass, which is what makes the AC-05 / NFR-PERF-1 envelope
// (≤2s render, 75 participants, warm cache) reachable.
//
// Substrate seam: SAD ADR-01 puts the cache on ElastiCache Redis in Production;
// §5.4 + the §1.5 slaughter list make Demo Mode Postgres-backed. The THREE
// operations below — `get` / `set` / `invalidate` — plus their input/output
// types ARE the contract. A Production Redis implementation re-exports the same
// names and the same types behind the same seam, so callers (P1C-01 warm-path
// read, P1C-03 CDC invalidation) consume it unchanged. Keep the contract
// substrate-neutral: no Postgres-ism leaks into the types.
//
// PII (Immutable #1): `payload` is opaque jsonb and the caller owns its shape,
// but it MUST carry only the engine-scored caseload — SF record IDs plus
// derived scores/tiers. The priority engine is opaque to participant identity
// (TR-PRIORITY-1), so its output holds no participant PII; callers must not
// widen the payload to include any.
//
// No audit row on `set` / `invalidate`: the cache holds derived data, not
// system-of-record state — same class as `rate_limits` / `idempotency_keys`,
// neither of which audits. The Pattern B / Immutable #5 audit row is emitted by
// the endpoint that mutates record state (P1C-01), not by this layer.

import { type SQL, and, eq, sql } from "drizzle-orm";

import type { DbOrTx } from "../db/types.js";
import { caseloadCache } from "../schema/index.js";

// Default freshness window. The CDC poll cadence is 30s (P1C-03); a row that
// has gone two poll cycles without a CDC invalidation is treated as `stale` so
// the UI can surface an "as of HH:MM" affordance (P1C-04). Within the AC-05 /
// NFR-PERF-1 envelope — the freshness window is the engineer's call per the
// P1C-02 ticket. Overridable per `set` via `freshnessWindowSeconds`.
export const DEFAULT_FRESHNESS_WINDOW_SECONDS = 60;

// `miss` — no cached row. `fresh` — row exists, within its freshness window.
// `stale` — row exists, past its window (no CDC event evicted it; it just aged).
export type CacheFreshness = "fresh" | "stale" | "miss";

// The cache key triple. Keying on `configVersion` means an M-CONFIG bump
// (P1C-05 tuning) cannot serve a stale payload — the new version simply misses.
export interface CaseloadCacheKey {
  specialistId: string;
  queueId: string;
  configVersion: number;
}

export interface CaseloadCacheReadResult<TPayload = unknown> {
  freshness: CacheFreshness;
  // Returned for both `fresh` AND `stale` — only `miss` is null. The caller
  // decides whether a `stale` payload is served as-is or triggers a rehydrate.
  payload: TPayload | null;
  // null only when `miss`.
  lastRefreshedAt: Date | null;
}

export interface SetCaseloadCacheInput<TPayload = unknown> extends CaseloadCacheKey {
  payload: TPayload;
  // Defaults to DEFAULT_FRESHNESS_WINDOW_SECONDS.
  freshnessWindowSeconds?: number;
}

// Invalidation scopes. `specialist` / `queue` / `configVersion` satisfy the
// P1C-02 acceptance criteria; `specialistQueue` (the precise pair) lets the
// P1C-03 CDC worker invalidate exactly the affected `{specialist_id, queue_id}`
// without that ticket having to modify `packages/persistence`.
export type InvalidateScope =
  | { kind: "specialist"; specialistId: string }
  | { kind: "queue"; queueId: string }
  | { kind: "configVersion"; configVersion: number }
  | { kind: "specialistQueue"; specialistId: string; queueId: string };

// Reads the cached payload for a key and resolves its freshness state.
// Freshness is computed in Postgres (NOW() vs `last_refreshed_at` + the per-row
// window) so there is no app/DB clock skew — mirrors the `rate_limits`
// fixed-window check.
export async function getCaseloadCache<TPayload = unknown>(
  db: DbOrTx,
  key: CaseloadCacheKey,
): Promise<CaseloadCacheReadResult<TPayload>> {
  const rows = await db
    .select({
      payload: caseloadCache.payload,
      lastRefreshedAt: caseloadCache.lastRefreshedAt,
      // `last_refreshed_at` and `freshness_window_seconds` are both NOT NULL, so
      // this comparison is always a real boolean — never null. That guarantee
      // is what keeps the result strictly `fresh | stale` (`miss` is the
      // no-row case below); do not relax those NOT NULL constraints.
      isFresh: sql<boolean>`NOW() - ${caseloadCache.lastRefreshedAt} <= make_interval(secs => ${caseloadCache.freshnessWindowSeconds})`,
    })
    .from(caseloadCache)
    .where(
      and(
        eq(caseloadCache.specialistId, key.specialistId),
        eq(caseloadCache.queueId, key.queueId),
        eq(caseloadCache.configVersion, key.configVersion),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) {
    return { freshness: "miss", payload: null, lastRefreshedAt: null };
  }
  return {
    freshness: row.isFresh ? "fresh" : "stale",
    payload: row.payload as TPayload,
    lastRefreshedAt: row.lastRefreshedAt,
  };
}

// Writes (or overwrites) the cached payload for a key. Idempotent: an
// `INSERT … ON CONFLICT (specialist_id, queue_id, config_version) DO UPDATE`
// on the composite PK, so a cold-path rehydrate (P1C-01) replacing an existing
// row is a single statement that also advances `last_refreshed_at` to NOW().
export async function setCaseloadCache<TPayload = unknown>(
  db: DbOrTx,
  input: SetCaseloadCacheInput<TPayload>,
): Promise<void> {
  const freshnessWindowSeconds =
    input.freshnessWindowSeconds ?? DEFAULT_FRESHNESS_WINDOW_SECONDS;
  await db
    .insert(caseloadCache)
    .values({
      specialistId: input.specialistId,
      queueId: input.queueId,
      configVersion: input.configVersion,
      payload: input.payload,
      freshnessWindowSeconds,
      // `last_refreshed_at` is left to its NOW() default on INSERT.
    })
    .onConflictDoUpdate({
      target: [
        caseloadCache.specialistId,
        caseloadCache.queueId,
        caseloadCache.configVersion,
      ],
      set: {
        payload: input.payload,
        freshnessWindowSeconds,
        lastRefreshedAt: sql`NOW()`,
      },
    });
}

// Evicts cached rows matching `scope`. Invalidation deletes (it does not
// soft-mark stale): a CDC-detected change means the cached payload is now
// wrong, so the next `get` should be a `miss` and force a cold rehydrate.
// Returns the number of rows evicted.
export async function invalidateCaseloadCache(
  db: DbOrTx,
  scope: InvalidateScope,
): Promise<number> {
  let where: SQL | undefined;
  switch (scope.kind) {
    case "specialist":
      // PK-prefix scan on `specialist_id`.
      where = eq(caseloadCache.specialistId, scope.specialistId);
      break;
    case "queue":
      // Secondary index `idx_caseload_cache_queue`.
      where = eq(caseloadCache.queueId, scope.queueId);
      break;
    case "configVersion":
      // Secondary index `idx_caseload_cache_config_version`.
      where = eq(caseloadCache.configVersion, scope.configVersion);
      break;
    case "specialistQueue":
      // PK-prefix scan on `(specialist_id, queue_id)`.
      where = and(
        eq(caseloadCache.specialistId, scope.specialistId),
        eq(caseloadCache.queueId, scope.queueId),
      );
      break;
    default: {
      // Exhaustiveness guard: a future InvalidateScope variant added without a
      // case here would leave `where` undefined, which Drizzle renders as an
      // unfiltered DELETE — a full-table wipe. Fail loud instead.
      const unhandled: never = scope;
      throw new Error(
        `invalidateCaseloadCache: unhandled scope ${JSON.stringify(unhandled)}`,
      );
    }
  }
  const deleted = await db
    .delete(caseloadCache)
    .where(where)
    .returning({ specialistId: caseloadCache.specialistId });
  return deleted.length;
}
