import type { Configuration } from "../config/index.js";

// P0-11 — returns a minimal valid Configuration for the calibration UI to
// pass into computePriority(). The DB-backed configuration row (ERD §6.6,
// P0-01) is the eventual source; until the configuration repository is
// wired into the BFF, the UI uses this in-process default so the surface
// can render without a database round-trip. P0-15 locks v1 in the DB.
//
// `factorWeights.additive` carries the demo calibration weights — the
// relative top/middle/light tiers derived from two specialist calibration
// sessions and the data lead's review (replacing the all-1.0 v0 baseline).
// Every key
// returned by `getActiveFactors()` (the BR-19 factors plus the BR-21 SBOP
// stub) MUST have a weight here, or VR-05 fail-loud trips the moment the
// calibration UI calls `computePriority()`. This stub is the Demo-Mode live
// configuration: the BFF reads weights from here until the DB-backed
// Configuration row is wired in. Two config-driven scoring caps shape the
// curve beneath the (untouched) categorical Tier-1 invariants:
//   - days-since-contact caps at `daysSinceContactScoringCapDays` (90, below);
//   - failed-attempts saturates at `tierInvariants.failed_attempts_tier1_threshold`
//     (the BR-24 escalation boundary) — see `factors/failed-attempts.ts`.
// Formal tuning lineage writes versioned `v{N}.json` weight files and an
// audited trace block from a real agreement-score run.
export function getCalibrationConfiguration(): Configuration {
  return {
    version: 0,
    isActive: false,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    createdBy: "p0-11-stub",
    activationAt: null,
    deactivatedAt: null,

    factorWeights: {
      additive: {
        // Top tier (primary drivers).
        days_since_last_contact: 3.0,
        arrears: 3.0,
        // Middle tier.
        recent_incident: 2.0,
        failed_attempts: 1.5,
        stability_visit_state: 1.5,
        voucher_recert_deadline: 1.0,
        // Light tier (tie-breakers).
        open_barriers: 0.5,
        // BR-19(h) — weight 0: considered, non-driving. Kept in the additive
        // set so it still surfaces as a factors[] breakdown row (BR-12),
        // reading as "considered" rather than removed.
        aftercare_extended: 0,
        // BR-19 factor (f) `unit_engagement` retired from the active set
        // (2026-05-20 Q15 Option B; P0-04f) — no weight needed: VR-05 only
        // requires a weight for each factor in getActiveFactors().
        // BR-21 SBOP Pattern F stub — factor returns 0 today; weight left at
        // 1.0 (calibration-neutral while the factor is dark).
        sbop: 1.0,
      },
      multiplicative_modifiers: {},
      overlap_caps: [],
    },
    // Tier cutoffs re-fit to the calibrated weight scale (P0-14). With
    // days_since_last_contact at weight 3.0 the dominant axis is contact
    // recency, so the cutoffs land on real cadence boundaries:
    //   tier1 (Act today)     >= 150  ≈ 50+ days since contact, or never
    //   tier2 (Act this week) >=  60  ≈ 20–50 days
    //   tier3 (Routine)        <  60  ≈ < 20 days
    // 50 days is well past the monthly check-in and approaching the 90-day
    // (quarterly) scoring cap; 20 days is the run-up to the monthly check-in
    // (cf. the 28–30 day queue windows below). The prior 80/50 cutoffs were
    // fit to the all-1.0 baseline and pinned the whole caseload to Tier 1
    // once days-since-contact was weighted up. BR-24/25/26 invariant floors
    // still override these cutoffs (a non-responsive case escalates to Tier 1
    // regardless of score).
    tierThresholds: { tier1_min: 150, tier2_min: 60 },
    // Queue universe (F-04 BR-22). The four spec'd queues; the predicate
    // thresholds (30 / 28 / 2) are taken straight from FS v1.12 BR-22
    // lines 583-586 and are tunable here without a code change. `isDefault`
    // lands on "Check-ins due this month" for the demo path (Q-DEMO-1) —
    // BR-22 authorizes config to set
    // the default; BR-20's seed value ("Caseload overview") is overridden here.
    // P1C-01 evaluates these predicates; P1C-04 renders the labels.
    queuePredicates: {
      caseload_overview: {
        displayLabel: "Caseload overview",
        predicate: { kind: "all_active" },
        sortKey: "priority_score_desc",
        isDefault: false,
        description: "All active participants in the caseload (BR-22).",
      },
      due_soon: {
        displayLabel: "Due soon",
        predicate: { kind: "due_within_days", params: { days: 30 } },
        sortKey: "priority_score_desc",
        isDefault: false,
        description:
          "Monthly check-in or stability checkpoint due within 30 days (BR-22).",
      },
      never_successfully_contacted: {
        displayLabel: "Never successfully contacted",
        predicate: {
          kind: "never_successfully_contacted",
          params: { minFailedAttempts: 2 },
        },
        sortKey: "priority_score_desc",
        isDefault: false,
        description:
          "At least 2 failed attempts and zero successful contacts ever (BR-22).",
      },
      check_ins_due_this_month: {
        displayLabel: "Check-ins due this month",
        predicate: {
          kind: "successful_contact_overdue",
          params: { minDaysSinceContact: 28, currentCalendarMonthOnly: true },
        },
        sortKey: "priority_score_desc",
        isDefault: true,
        description:
          "Last successful contact >=28 days old and a check-in due this " +
          "calendar month (BR-22); demo default landing queue (Q-DEMO-1).",
      },
    },
    barrierSeverityClassification: {},
    // P1E-03 / BR-19(e) / BR-37 — per-tier weights consumed by open_barriers.
    // BR-39 staleness: ×1.5 when `Days_Since_Last_Update__c` ≥ 30. Values are
    // Demo placeholders pending Julia's review of
    // `barrier_severity_classification_draft.md`; calibration sprint validates.
    barrierSeverityHigh: "3.00",
    barrierSeverityMedium: "2.00",
    barrierSeverityLow: "1.00",
    barrierStalenessMultiplier: "1.50",
    barrierStalenessThresholdDays: 30,
    // BR-24 lit at the spec's default threshold N=3 (FS v1.12:515). BR-25/26
    // stay dark in Demo Mode: BR-25's `open_repair_invariant` block is `null`
    // (P0-04e — the invariant lands config-ready but fires only once
    // `Repair__c` hydration is projected onto the participant), and BR-26's
    // `barrier_type_to_invariant` map is empty (the picklist extension is
    // pending Erik, Q23).
    // P0-04b — `invariant_override_suppression: true` per TRD §451 default;
    // suppression hydration is a Pattern F stub today so the rule is a no-op
    // until SBOP ratifies.
    tierInvariants: {
      failed_attempts_tier1_threshold: 3,
      barrier_type_to_invariant: {},
      open_repair_invariant: null,
      invariant_override_suppression: true,
    },

    dueStatusLeadTimeDays: 14,
    voucherRecertWarningDays: 30,
    recentIncidentWindowDays: 30,
    // BR-19(a) — cap the days-since-last-contact factor at the quarterly visit
    // cadence (90 days). Never-contacted (BR-15) and any gap ≥ 90 both
    // contribute 90; at weight 3.0 that is 270 ≫ tier1_min (80), so a
    // never-contacted case still tops the tier without a runaway sentinel.
    daysSinceContactScoringCapDays: 90,
    failedAttemptResetOnCompleted: true,
    recalibrationCadenceDays: 90,

    calibrationAlpha: "1.00",
    calibrationBeta: "2.00",
    calibrationThresholdPct: "85.00",
    calibrationParticipantsFloor: 10,

    sbopPath: "C",
    sbopSuppressionDays: 14,
    sbopEnabled: false,

    capacityStrainMultiplier: "1.6",
    capacityStrainPersistenceDays: 4,

    quietHoursStartLocal: "21:00:00",
    quietHoursEndLocal: "08:00:00",

    mogliTimeoutSeconds: 5,
    mogliBackoffSeconds: [5, 15, 45, 120, 300],

    offlineMaxQueueDepth: 100,
    offlineMaxRetries: 5,
    idempotencyTtlHours: 24,
    hardRefreshRateLimitSeconds: 30,

    nightlyRefreshCron: "0 2 * * *",
    weeklyDigestCron: "0 8 * * MON",
    dailyDigestCron: "0 8 * * *",

    tieBreakerStrategy: "oldest_contact_then_id",

    featureFlags: {},
    approvalMetadata: null,
    notes: "P0-11 calibration UI stub configuration",
  };
}
