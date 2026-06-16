-- Reverse of 0002_init_phase_1_foundation.sql.
-- The four Phase 1 foundation tables are independent: no FKs between them
-- and no FKs to Phase 0 tables. Drop order is cosmetic; mirrors the
-- reverse of the CREATE TABLE order in the forward migration.
DROP TABLE IF EXISTS "sessions";
DROP TABLE IF EXISTS "notification_preferences";
DROP TABLE IF EXISTS "idempotency_keys";
DROP TABLE IF EXISTS "audit_log";
