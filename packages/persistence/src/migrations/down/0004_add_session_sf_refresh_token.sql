-- Reverse of 0004_add_session_sf_refresh_token.sql.
ALTER TABLE "sessions" DROP COLUMN IF EXISTS "sf_refresh_token_encrypted";
