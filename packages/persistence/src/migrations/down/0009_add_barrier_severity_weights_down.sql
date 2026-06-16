-- Reverse of 0009_add_barrier_severity_weights.sql.
ALTER TABLE "configuration"
  DROP COLUMN IF EXISTS "barrier_severity_high_weight",
  DROP COLUMN IF EXISTS "barrier_severity_medium_weight",
  DROP COLUMN IF EXISTS "barrier_severity_low_weight",
  DROP COLUMN IF EXISTS "barrier_staleness_multiplier",
  DROP COLUMN IF EXISTS "barrier_staleness_threshold_days";
