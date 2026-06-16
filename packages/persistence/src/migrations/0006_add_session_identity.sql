-- P1B-05: Add specialist identity columns to `sessions` — `display_name`,
-- `email`, and `timezone`. They are captured from the Salesforce User record
-- at `/auth/callback` (E-02) and read back by `GET /api/v1/me` (E-05). Storing
-- them on the session row keeps `/me` a pure DB read: no Salesforce round-trip
-- mid-session, and therefore no refresh-token exchange (and no token rotation)
-- on a GET. These are the SIGNED-IN SPECIALIST's own identity — staff data,
-- not participant PII (Immutable #1 governs participant data) — and sit
-- alongside the existing `ip_address` / `user_agent_hash` session columns.
--
-- Nullable with no default: a session row can structurally exist before the
-- callback wires the values (mirrors `sf_refresh_token_encrypted`, 0004), and
-- these are Demo-Mode-only artifacts — at the Production substrate swap the
-- session moves to Redis, so these columns are dropped, not migrated.
-- Additive — satisfies the Phase-1 additive-only rule. ERD §6.8 amended to match.
ALTER TABLE "sessions" ADD COLUMN "display_name" varchar(255);--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "email" varchar(255);--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "timezone" varchar(50);
