-- Reverse of 0003_add_session_token_hash.sql.
-- DROP COLUMN alone would cascade to the index; the explicit DROP INDEX keeps
-- the reversal order legible.
DROP INDEX IF EXISTS "idx_sessions_token_hash";
ALTER TABLE "sessions" DROP COLUMN IF EXISTS "token_hash";
