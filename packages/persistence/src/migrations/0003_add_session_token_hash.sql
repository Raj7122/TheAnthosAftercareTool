-- P1A-04: Add `token_hash` to `sessions` — the SHA-256 (64-char hex) of the
-- opaque 256-bit session token (ADR-03). The cookie carries the plaintext
-- token; the DB stores only its hash, so a DB dump never yields a live token.
-- The unique index both enforces one row per hash and serves the O(1) session
-- lookup keyed by `hashToken(cookie)`.
--
-- NOT NULL with no default: `sessions` is empty at sub-phase 1A (rows are first
-- created by the P1B `/auth/callback` flow). Truncate any stale dev rows before
-- applying. ERD §6.8 amended to match.
ALTER TABLE "sessions" ADD COLUMN "token_hash" varchar(64) NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_sessions_token_hash" ON "sessions" USING btree ("token_hash");
