-- Reverse of 0012_add_days_since_contact_cap.sql.
ALTER TABLE "configuration"
  DROP COLUMN IF EXISTS "days_since_contact_scoring_cap_days";
