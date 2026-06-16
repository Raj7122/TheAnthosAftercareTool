import { isDeepStrictEqual } from "node:util";

import type { Actor } from "@anthos/auth";
import type { ConfigurationPayload } from "@anthos/domain";

// Stable list of payload fields participating in `configuration_audit`. Order
// here is the audit-row emission order — keep it deterministic so tests can
// pin against it. Maps a snake_case `field_path` (ERD §6.7) to the camelCase
// key on ConfigurationPayload.
export const PAYLOAD_FIELDS: ReadonlyArray<{
  fieldPath: string;
  payloadKey: keyof ConfigurationPayload;
}> = [
  { fieldPath: "factor_weights", payloadKey: "factorWeights" },
  { fieldPath: "tier_thresholds", payloadKey: "tierThresholds" },
  { fieldPath: "queue_predicates", payloadKey: "queuePredicates" },
  {
    fieldPath: "barrier_severity_classification",
    payloadKey: "barrierSeverityClassification",
  },
  // P1E-03 — BR-19(e) / BR-37 severity weights + BR-39 staleness controls.
  { fieldPath: "barrier_severity_high_weight", payloadKey: "barrierSeverityHigh" },
  {
    fieldPath: "barrier_severity_medium_weight",
    payloadKey: "barrierSeverityMedium",
  },
  { fieldPath: "barrier_severity_low_weight", payloadKey: "barrierSeverityLow" },
  {
    fieldPath: "barrier_staleness_multiplier",
    payloadKey: "barrierStalenessMultiplier",
  },
  {
    fieldPath: "barrier_staleness_threshold_days",
    payloadKey: "barrierStalenessThresholdDays",
  },
  { fieldPath: "due_status_lead_time_days", payloadKey: "dueStatusLeadTimeDays" },
  { fieldPath: "voucher_recert_warning_days", payloadKey: "voucherRecertWarningDays" },
  { fieldPath: "recent_incident_window_days", payloadKey: "recentIncidentWindowDays" },
  {
    fieldPath: "days_since_contact_scoring_cap_days",
    payloadKey: "daysSinceContactScoringCapDays",
  },
  {
    fieldPath: "failed_attempt_reset_on_completed",
    payloadKey: "failedAttemptResetOnCompleted",
  },
  { fieldPath: "recalibration_cadence_days", payloadKey: "recalibrationCadenceDays" },
  { fieldPath: "calibration_alpha", payloadKey: "calibrationAlpha" },
  { fieldPath: "calibration_beta", payloadKey: "calibrationBeta" },
  { fieldPath: "calibration_threshold_pct", payloadKey: "calibrationThresholdPct" },
  {
    fieldPath: "calibration_participants_floor",
    payloadKey: "calibrationParticipantsFloor",
  },
  { fieldPath: "sbop_path", payloadKey: "sbopPath" },
  { fieldPath: "sbop_suppression_days", payloadKey: "sbopSuppressionDays" },
  { fieldPath: "sbop_enabled", payloadKey: "sbopEnabled" },
  { fieldPath: "capacity_strain_multiplier", payloadKey: "capacityStrainMultiplier" },
  {
    fieldPath: "capacity_strain_persistence_days",
    payloadKey: "capacityStrainPersistenceDays",
  },
  { fieldPath: "quiet_hours_start_local", payloadKey: "quietHoursStartLocal" },
  { fieldPath: "quiet_hours_end_local", payloadKey: "quietHoursEndLocal" },
  { fieldPath: "mogli_timeout_seconds", payloadKey: "mogliTimeoutSeconds" },
  { fieldPath: "mogli_backoff_seconds", payloadKey: "mogliBackoffSeconds" },
  { fieldPath: "offline_max_queue_depth", payloadKey: "offlineMaxQueueDepth" },
  { fieldPath: "offline_max_retries", payloadKey: "offlineMaxRetries" },
  { fieldPath: "idempotency_ttl_hours", payloadKey: "idempotencyTtlHours" },
  {
    fieldPath: "hard_refresh_rate_limit_seconds",
    payloadKey: "hardRefreshRateLimitSeconds",
  },
  { fieldPath: "nightly_refresh_cron", payloadKey: "nightlyRefreshCron" },
  { fieldPath: "weekly_digest_cron", payloadKey: "weeklyDigestCron" },
  { fieldPath: "daily_digest_cron", payloadKey: "dailyDigestCron" },
  { fieldPath: "tie_breaker_strategy", payloadKey: "tieBreakerStrategy" },
  { fieldPath: "feature_flags", payloadKey: "featureFlags" },
  { fieldPath: "approval_metadata", payloadKey: "approvalMetadata" },
  { fieldPath: "notes", payloadKey: "notes" },
];

export interface AuditRowDraft {
  fieldPath: string;
  priorValue: unknown;
  newValue: unknown;
  versionFrom: number | null;
  versionTo: number;
  actorId: string;
  reason: string;
}

export interface DiffContext {
  versionFrom: number | null;
  versionTo: number;
  actor: Actor;
  reason: string;
}

// Builds one audit row per payload field whose value differs between `prior`
// and `next`. On bootstrap (prior=null), emits one row per payload field with
// priorValue=null and newValue=<payload[field]> — gives auditors a complete
// snapshot of the starting state without inferring it from elsewhere.
export function buildPayloadAuditRows(
  ctx: DiffContext,
  prior: ConfigurationPayload | null,
  next: ConfigurationPayload,
): AuditRowDraft[] {
  const rows: AuditRowDraft[] = [];
  for (const { fieldPath, payloadKey } of PAYLOAD_FIELDS) {
    // payloadKey is a `keyof ConfigurationPayload` from a const-asserted list;
    // not user-controllable, so the object-injection lint warning is a false
    // positive here.
    // eslint-disable-next-line security/detect-object-injection
    const newValue = next[payloadKey];
    if (prior === null) {
      rows.push({
        fieldPath,
        priorValue: null,
        newValue,
        versionFrom: ctx.versionFrom,
        versionTo: ctx.versionTo,
        actorId: ctx.actor.id,
        reason: ctx.reason,
      });
      continue;
    }
    // eslint-disable-next-line security/detect-object-injection
    const priorValue = prior[payloadKey];
    if (!isDeepStrictEqual(priorValue, newValue)) {
      rows.push({
        fieldPath,
        priorValue,
        newValue,
        versionFrom: ctx.versionFrom,
        versionTo: ctx.versionTo,
        actorId: ctx.actor.id,
        reason: ctx.reason,
      });
    }
  }
  return rows;
}

// Audit rows for a single activation operation: one row for the newly-active
// version, plus (if a prior active existed) one row for the deactivated one.
export function buildActivationAuditRows(
  ctx: Omit<DiffContext, "versionFrom" | "versionTo"> & {
    activatingVersion: number;
    deactivatingVersion: number | null;
  },
): AuditRowDraft[] {
  const rows: AuditRowDraft[] = [];
  if (ctx.deactivatingVersion !== null) {
    rows.push({
      fieldPath: "is_active",
      priorValue: true,
      newValue: false,
      versionFrom: ctx.deactivatingVersion,
      versionTo: ctx.deactivatingVersion,
      actorId: ctx.actor.id,
      reason: ctx.reason,
    });
  }
  rows.push({
    fieldPath: "is_active",
    priorValue: false,
    newValue: true,
    versionFrom: ctx.deactivatingVersion,
    versionTo: ctx.activatingVersion,
    actorId: ctx.actor.id,
    reason: ctx.reason,
  });
  return rows;
}
