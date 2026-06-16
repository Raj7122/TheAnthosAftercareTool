import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";

// P1C-02: server-side cache for engine-scored caseload payloads (F-02, F-04).
// The warm-path read for the caseload view (AC-05 / NFR-PERF-1: ≤2s render,
// 75 participants, warm cache) reads one row from here instead of re-running
// the bulk Salesforce SOQL hydrate + priority-engine pass.
//
// Demo-Mode substrate: Postgres. SAD ADR-01 puts the cache on ElastiCache Redis
// in Production; §5.4 (and the §1.5 slaughter list, Redis deferred) makes Demo
// Mode Postgres-backed. The cache *contract* (repositories/caseload-cache.ts)
// is substrate-agnostic — at the Production swap this table is dropped, not
// migrated (mirrors `sessions` / `idempotency_keys` / `rate_limits`).
//
// PII discipline (Immutable #1): `payload` carries only the engine-scored
// caseload — SF record IDs plus derived scores/tiers/factor breakdowns. The
// priority engine is opaque to participant identity (TR-PRIORITY-1), so its
// output holds no participant names or other PII. Callers (P1C-01) MUST keep
// it that way: no participant PII beyond Salesforce record IDs in this table.
//
// Not enumerated in ERD v1.4 — the ERD patch is tracked in the PR description.
export const caseloadCache = pgTable(
  "caseload_cache",
  {
    // Cache key, part 1 — the Salesforce User Id of the caseload's owner.
    specialistId: varchar("specialist_id", { length: 50 }).notNull(),
    // Cache key, part 2 — the M-CONFIG queue-predicate name (F-04 / BR-22).
    // `configuration.queuePredicates` keys are non-empty strings; 100 chars
    // leaves headroom over any realistic predicate name.
    queueId: varchar("queue_id", { length: 100 }).notNull(),
    // Cache key, part 3 — the active configuration version when the payload
    // was scored. Keying on it means an M-CONFIG bump (P1C-05 tuning) cannot
    // serve a stale payload: the new version simply misses and cold-hydrates.
    configVersion: integer("config_version").notNull(),
    // The engine-scored caseload payload. Opaque jsonb here; the caller owns
    // its shape (P1C-01). PII-free by the engine-purity invariant above.
    payload: jsonb("payload").notNull(),
    // When the payload was computed. Powers freshness resolution and the
    // P1C-04 "as of HH:MM" affordance. Advanced to NOW() on every write.
    lastRefreshedAt: timestamp("last_refreshed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Per-row freshness window: a row is `fresh` while NOW() − last_refreshed_at
    // is within this many seconds, `stale` once past it. Stored per row so the
    // window survives the Production substrate swap and can vary per write.
    freshnessWindowSeconds: integer("freshness_window_seconds").notNull(),
  },
  (table) => ({
    // The cache key IS the primary key — composite, no surrogate id needed.
    pk: primaryKey({
      columns: [table.specialistId, table.queueId, table.configVersion],
    }),
    // `invalidate` by specialist and by {specialist, queue} ride the PK prefix;
    // these two cover the non-prefix scopes (by queue, by config-version).
    queueIdx: index("idx_caseload_cache_queue").on(table.queueId),
    configVersionIdx: index("idx_caseload_cache_config_version").on(
      table.configVersion,
    ),
    configVersionCheck: check(
      "caseload_cache_config_version_check",
      sql`${table.configVersion} > 0`,
    ),
    freshnessWindowCheck: check(
      "caseload_cache_freshness_window_check",
      sql`${table.freshnessWindowSeconds} > 0`,
    ),
    // The two key string columns reject the empty string — an empty cache key
    // is a row no non-degenerate `get` could ever reach.
    specialistIdCheck: check(
      "caseload_cache_specialist_id_check",
      sql`${table.specialistId} <> ''`,
    ),
    queueIdCheck: check(
      "caseload_cache_queue_id_check",
      sql`${table.queueId} <> ''`,
    ),
  }),
).enableRLS();
