-- Reverse of 0006_add_session_identity.sql.
ALTER TABLE "sessions" DROP COLUMN IF EXISTS "display_name";
ALTER TABLE "sessions" DROP COLUMN IF EXISTS "email";
ALTER TABLE "sessions" DROP COLUMN IF EXISTS "timezone";
