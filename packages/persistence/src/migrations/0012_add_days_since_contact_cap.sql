-- P0-14: Add the days-since-last-contact scoring cap to `configuration`
-- (BR-19(a)).
--
-- Caps the per-factor value on the days-since-last-contact factor at a real
-- operational boundary (90 = quarterly visit cadence) rather than a runaway
-- never-contacted sentinel. The factor reads this value; never-contacted
-- (BR-15) and any gap ≥ cap both contribute the cap.
--
-- Default 90 preserves the calibrated demo behavior. Required at parse time on
-- the Zod side (configurationSchema, `.default(90)`) — VR-05 fail-loud against
-- a missing value.
ALTER TABLE "configuration"
  ADD COLUMN "days_since_contact_scoring_cap_days" smallint NOT NULL DEFAULT 90;
