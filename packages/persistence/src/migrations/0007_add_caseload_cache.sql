-- P1C-02: Add `caseload_cache` — the Demo-Mode server-side cache for
-- engine-scored caseload payloads (F-02, F-04). The warm-path caseload read
-- (AC-05 / NFR-PERF-1: ≤2s render, 75 participants, warm cache) hits one row
-- here instead of re-running the bulk Salesforce SOQL hydrate + priority-engine
-- pass. Keyed by `{specialist_id, queue_id, config_version}`.
--
-- Demo-Mode substrate is Postgres: SAD ADR-01 puts the cache on ElastiCache
-- Redis in Production; §5.4 + the §1.5 slaughter list defer Redis. The cache
-- contract (repositories/caseload-cache.ts) is substrate-agnostic — at the
-- Production swap this table is dropped, not migrated (mirrors `sessions` /
-- `idempotency_keys` / `rate_limits`).
--
-- PII (Immutable #1): `payload` holds only the engine-scored caseload — SF
-- record IDs plus derived scores/tiers; the priority engine is opaque to
-- participant identity (TR-PRIORITY-1), so no participant PII lands here.
--
-- Additive (a new table) — satisfies the Phase-1 additive-only rule. Not
-- enumerated in ERD v1.4 — ERD patch tracked in the PR description.
CREATE TABLE "caseload_cache" (
	"specialist_id" varchar(50) NOT NULL,
	"queue_id" varchar(100) NOT NULL,
	"config_version" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"last_refreshed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"freshness_window_seconds" integer NOT NULL,
	CONSTRAINT "caseload_cache_specialist_id_queue_id_config_version_pk" PRIMARY KEY("specialist_id","queue_id","config_version"),
	CONSTRAINT "caseload_cache_config_version_check" CHECK ("caseload_cache"."config_version" > 0),
	CONSTRAINT "caseload_cache_freshness_window_check" CHECK ("caseload_cache"."freshness_window_seconds" > 0),
	CONSTRAINT "caseload_cache_specialist_id_check" CHECK ("caseload_cache"."specialist_id" <> ''),
	CONSTRAINT "caseload_cache_queue_id_check" CHECK ("caseload_cache"."queue_id" <> '')
);
--> statement-breakpoint
CREATE INDEX "idx_caseload_cache_queue" ON "caseload_cache" USING btree ("queue_id");--> statement-breakpoint
CREATE INDEX "idx_caseload_cache_config_version" ON "caseload_cache" USING btree ("config_version");
