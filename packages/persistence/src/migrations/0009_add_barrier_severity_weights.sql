-- P1E-03: Add barrier severity numeric weights + BR-39 staleness controls
-- to `configuration` (BR-19(e) / BR-37 + BR-39).
--
-- The three severity weights replace the openBarriersFactor's previously
-- hardcoded ordinals (3/2/1). The staleness multiplier and threshold
-- implement BR-39 — barriers untouched ≥ thresholdDays receive the
-- configured multiplier on their per-Barrier contribution.
--
-- Defaults preserve current calibration behavior: 3/2/1 severity, 1.50×
-- multiplier at 30-day threshold. Calibration sprint validates concrete
-- values once Julia approves `barrier_severity_classification_draft.md`.
--
-- Required at parse time on the Zod side (configurationSchema) — VR-05 /
-- AC-15 fail-loud against missing or non-numeric values.
ALTER TABLE "configuration"
  ADD COLUMN "barrier_severity_high_weight"     numeric(5, 2) NOT NULL DEFAULT '3.00',
  ADD COLUMN "barrier_severity_medium_weight"   numeric(5, 2) NOT NULL DEFAULT '2.00',
  ADD COLUMN "barrier_severity_low_weight"      numeric(5, 2) NOT NULL DEFAULT '1.00',
  ADD COLUMN "barrier_staleness_multiplier"     numeric(4, 2) NOT NULL DEFAULT '1.50',
  ADD COLUMN "barrier_staleness_threshold_days" smallint      NOT NULL DEFAULT 30;
