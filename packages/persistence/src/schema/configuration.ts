import { sql } from "drizzle-orm";
import {
  boolean,
  char,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  smallint,
  text,
  time,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

// ERD v1.4 §6.6: versioned immutable operational configuration.
// New admin change appends a new row; field-level changes write to configuration_audit.
export const configuration = pgTable(
  "configuration",
  {
    version: integer("version").primaryKey(),
    isActive: boolean("is_active").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdBy: varchar("created_by", { length: 50 }).notNull(),
    activationAt: timestamp("activation_at", { withTimezone: true }),
    deactivatedAt: timestamp("deactivated_at", { withTimezone: true }),

    factorWeights: jsonb("factor_weights").notNull(),
    tierThresholds: jsonb("tier_thresholds").notNull(),
    queuePredicates: jsonb("queue_predicates").notNull(),
    barrierSeverityClassification: jsonb("barrier_severity_classification").notNull(),
    // BR-19(e) / BR-37 — per-tier numeric severity weights; BR-39 staleness
    // multiplier + threshold. Added by migration 0009 (P1E-03). Demo seed
    // defaults preserve the prior hardcoded ordinal behavior (3/2/1) and
    // BR-39's 30-day threshold; calibration sprint validates concrete values.
    // Drizzle TS property names MUST mirror the Zod `configurationSchema`
    // keys (no `Weight` suffix) — `parseRow()` in repositories/config.ts
    // passes Drizzle rows directly through `configurationSchema.safeParse()`.
    // SQL column names (with `_weight`) are unaffected; only the TS keys
    // need to line up.
    barrierSeverityHigh: numeric("barrier_severity_high_weight", {
      precision: 5,
      scale: 2,
    })
      .notNull()
      .default("3.00"),
    barrierSeverityMedium: numeric("barrier_severity_medium_weight", {
      precision: 5,
      scale: 2,
    })
      .notNull()
      .default("2.00"),
    barrierSeverityLow: numeric("barrier_severity_low_weight", {
      precision: 5,
      scale: 2,
    })
      .notNull()
      .default("1.00"),
    barrierStalenessMultiplier: numeric("barrier_staleness_multiplier", {
      precision: 4,
      scale: 2,
    })
      .notNull()
      .default("1.50"),
    barrierStalenessThresholdDays: smallint("barrier_staleness_threshold_days")
      .notNull()
      .default(30),
    // Categorical Tier 1 invariants (BR-24/25/26, TR-PRIORITY-15/16/17).
    // Demo seed default mirrors migration 0001; keeps schema TS in lockstep
    // with the snapshot so `db:generate` doesn't propose a spurious DROP DEFAULT.
    tierInvariants: jsonb("tier_invariants")
      .notNull()
      .default(
        sql`'{"failed_attempts_tier1_threshold": 3, "barrier_type_to_invariant": {}}'::jsonb`,
      ),

    dueStatusLeadTimeDays: smallint("due_status_lead_time_days").notNull().default(14),
    voucherRecertWarningDays: smallint("voucher_recert_warning_days").notNull().default(30),
    recentIncidentWindowDays: smallint("recent_incident_window_days").notNull().default(30),
    // BR-19(a) — scoring cap (days) on the days-since-last-contact factor.
    // Added by migration 0012. Default 90 = quarterly visit cadence.
    daysSinceContactScoringCapDays: smallint("days_since_contact_scoring_cap_days")
      .notNull()
      .default(90),
    failedAttemptResetOnCompleted: boolean("failed_attempt_reset_on_completed")
      .notNull()
      .default(true),
    recalibrationCadenceDays: integer("recalibration_cadence_days").notNull().default(90),

    calibrationAlpha: numeric("calibration_alpha", { precision: 4, scale: 2 })
      .notNull()
      .default("1.00"),
    calibrationBeta: numeric("calibration_beta", { precision: 4, scale: 2 })
      .notNull()
      .default("2.00"),
    calibrationThresholdPct: numeric("calibration_threshold_pct", { precision: 5, scale: 2 })
      .notNull()
      .default("85.00"),
    calibrationParticipantsFloor: smallint("calibration_participants_floor")
      .notNull()
      .default(10),

    sbopPath: char("sbop_path", { length: 1 }).notNull(),
    sbopSuppressionDays: integer("sbop_suppression_days").notNull().default(14),
    sbopEnabled: boolean("sbop_enabled").notNull().default(false),

    capacityStrainMultiplier: numeric("capacity_strain_multiplier", {
      precision: 3,
      scale: 1,
    })
      .notNull()
      .default("1.6"),
    capacityStrainPersistenceDays: smallint("capacity_strain_persistence_days")
      .notNull()
      .default(4),

    quietHoursStartLocal: time("quiet_hours_start_local").notNull().default("21:00:00"),
    quietHoursEndLocal: time("quiet_hours_end_local").notNull().default("08:00:00"),

    mogliTimeoutSeconds: smallint("mogli_timeout_seconds").notNull().default(5),
    mogliBackoffSeconds: jsonb("mogli_backoff_seconds")
      .notNull()
      .default(sql`'[5, 15, 45, 120, 300]'::jsonb`),

    offlineMaxQueueDepth: smallint("offline_max_queue_depth").notNull().default(100),
    offlineMaxRetries: smallint("offline_max_retries").notNull().default(5),
    idempotencyTtlHours: smallint("idempotency_ttl_hours").notNull().default(24),
    hardRefreshRateLimitSeconds: smallint("hard_refresh_rate_limit_seconds")
      .notNull()
      .default(30),

    nightlyRefreshCron: varchar("nightly_refresh_cron", { length: 50 })
      .notNull()
      .default("0 2 * * *"),
    weeklyDigestCron: varchar("weekly_digest_cron", { length: 50 })
      .notNull()
      .default("0 8 * * MON"),
    dailyDigestCron: varchar("daily_digest_cron", { length: 50 })
      .notNull()
      .default("0 8 * * *"),

    tieBreakerStrategy: varchar("tie_breaker_strategy", { length: 50 })
      .notNull()
      .default("oldest_contact_then_id"),

    featureFlags: jsonb("feature_flags").notNull().default(sql`'{}'::jsonb`),
    approvalMetadata: jsonb("approval_metadata"),
    notes: text("notes"),
  },
  (table) => ({
    sbopPathCheck: check(
      "configuration_sbop_path_check",
      sql`${table.sbopPath} IN ('A', 'B', 'C')`,
    ),
    // Partial unique index: at most one row may have is_active = true.
    activeUnique: uniqueIndex("idx_configuration_active")
      .on(table.isActive)
      .where(sql`is_active = true`),
    createdAtIdx: index("idx_configuration_created_at").on(table.createdAt.desc()),
  }),
).enableRLS();
