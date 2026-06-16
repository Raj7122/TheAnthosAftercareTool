-- Enable Row-Level Security on every `public` table.
--
-- Supabase exposes the `public` schema through PostgREST (the Data API). With
-- RLS disabled, the `anon`/`authenticated` API roles held full DML on every
-- table — an anonymous caller could read `sessions` (token hashes + SF refresh
-- tokens) and DELETE/TRUNCATE `audit_log`, breaking the INSERT-only audit
-- invariant. Supabase advisor `rls_disabled_in_public` flagged this as CRITICAL.
--
-- The tool reaches Postgres only via the direct pooler connection as the
-- `postgres` role (BYPASSRLS), never through PostgREST. Enabling RLS with NO
-- policies = deny-all for `anon`/`authenticated` while the app is unaffected.
--
-- `ENABLE` (not `FORCE`) keeps this portable to the Production RDS substrate:
-- the table owner and any BYPASSRLS role still have full access, and no `anon`
-- role exists there — so this migration is a harmless no-op outside Supabase.
-- Idempotent: re-running on an already-enabled table is a no-op.
--
-- Maps to immutable #5 (audit log INSERT-only), SEC-AUDIT integrity. Additive
-- (no table/column changes) — satisfies the post-Phase-1 additive-only rule.
ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "caseload_cache" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "cdc_health" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "configuration" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "configuration_audit" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "notification_preferences" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "offline_queue" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "rate_limits" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sessions" ENABLE ROW LEVEL SECURITY;
