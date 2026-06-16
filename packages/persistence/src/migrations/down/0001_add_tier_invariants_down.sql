-- Reverse of 0001_add_tier_invariants.sql.
ALTER TABLE "configuration" DROP COLUMN IF EXISTS "tier_invariants";
