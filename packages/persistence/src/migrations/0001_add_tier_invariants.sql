-- P0-04a: Add `tier_invariants` jsonb column to `configuration` for the
-- categorical Tier 1 invariants (BR-24/25/26, TR-PRIORITY-15/16/17).
--
-- Default holds Demo Mode posture: BR-24 N=3 (FS v1.12:515 starting value)
-- and an empty `barrier_type_to_invariant` map so BR-25/26 never fire until
-- Anthos extends the Salesforce Barriers picklist (Tier 2 Q22/Q23).
--
-- Schema (mirrors `tierInvariantsSchema` in packages/domain/src/config/schema.ts):
--   {
--     "failed_attempts_tier1_threshold": number,
--     "barrier_type_to_invariant": {
--       [barrierTypeLabel]: { "invariant_id": string, "display_label": string }
--     }
--   }
ALTER TABLE "configuration"
  ADD COLUMN "tier_invariants" jsonb NOT NULL
  DEFAULT '{"failed_attempts_tier1_threshold": 3, "barrier_type_to_invariant": {}}'::jsonb;
