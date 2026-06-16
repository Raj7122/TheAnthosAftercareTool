import type { Actor } from "@anthos/auth";
import type { ConfigurationPayload } from "@anthos/domain";
import { describe, expect, it } from "vitest";

import {
  buildActivationAuditRows,
  buildPayloadAuditRows,
  PAYLOAD_FIELDS,
} from "../../src/repositories/config-diff.js";

const ACTOR: Actor = { id: "admin1", role: "SYSTEM_ADMIN" };

describe("buildPayloadAuditRows", () => {
  it("emits one row per payload field on bootstrap (prior=null)", () => {
    const rows = buildPayloadAuditRows(
      { versionFrom: null, versionTo: 1, actor: ACTOR, reason: "bootstrap" },
      null,
      makePayload(),
    );
    expect(rows.length).toBe(PAYLOAD_FIELDS.length);
    expect(rows.every((r) => r.priorValue === null)).toBe(true);
    expect(rows.every((r) => r.versionFrom === null && r.versionTo === 1)).toBe(true);
    expect(new Set(rows.map((r) => r.fieldPath))).toEqual(
      new Set(PAYLOAD_FIELDS.map((f) => f.fieldPath)),
    );
  });

  it("emits zero rows when prior == next (no change)", () => {
    const payload = makePayload();
    const rows = buildPayloadAuditRows(
      { versionFrom: 1, versionTo: 2, actor: ACTOR, reason: "noop" },
      payload,
      payload,
    );
    expect(rows).toEqual([]);
  });

  it("emits exactly one row for a single-column change", () => {
    const prior = makePayload();
    const next: ConfigurationPayload = {
      ...prior,
      tieBreakerStrategy: "lowest_id",
    };
    const rows = buildPayloadAuditRows(
      { versionFrom: 1, versionTo: 2, actor: ACTOR, reason: "tweak tie-breaker" },
      prior,
      next,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.fieldPath).toBe("tie_breaker_strategy");
    expect(rows[0]?.priorValue).toBe("oldest_contact_then_id");
    expect(rows[0]?.newValue).toBe("lowest_id");
    expect(rows[0]?.versionFrom).toBe(1);
    expect(rows[0]?.versionTo).toBe(2);
  });

  it("treats deeply-equal jsonb values as unchanged", () => {
    const prior = makePayload();
    const next: ConfigurationPayload = {
      ...prior,
      factorWeights: {
        additive: { days_since_last_contact: 1.5 },
        multiplicative_modifiers: {},
        overlap_caps: [],
      },
    };
    const rows = buildPayloadAuditRows(
      { versionFrom: 1, versionTo: 2, actor: ACTOR, reason: "n/a" },
      prior,
      next,
    );
    expect(rows).toEqual([]);
  });

  it("detects a change inside a jsonb column", () => {
    const prior = makePayload();
    const next: ConfigurationPayload = {
      ...prior,
      factorWeights: {
        additive: { days_since_last_contact: 2.0 },
        multiplicative_modifiers: {},
        overlap_caps: [],
      },
    };
    const rows = buildPayloadAuditRows(
      { versionFrom: 1, versionTo: 2, actor: ACTOR, reason: "bump weight" },
      prior,
      next,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.fieldPath).toBe("factor_weights");
  });

  it("propagates actor.id and reason onto every emitted row", () => {
    const rows = buildPayloadAuditRows(
      {
        versionFrom: null,
        versionTo: 1,
        actor: { id: "calibration-script", role: "SYSTEM_ADMIN" },
        reason: "P0-14 calibration round 1",
      },
      null,
      makePayload(),
    );
    expect(rows.every((r) => r.actorId === "calibration-script")).toBe(true);
    expect(rows.every((r) => r.reason === "P0-14 calibration round 1")).toBe(true);
  });
});

describe("buildActivationAuditRows", () => {
  it("emits a single row when no prior active version exists", () => {
    const rows = buildActivationAuditRows({
      activatingVersion: 1,
      deactivatingVersion: null,
      actor: ACTOR,
      reason: "first activation",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.fieldPath).toBe("is_active");
    expect(rows[0]?.priorValue).toBe(false);
    expect(rows[0]?.newValue).toBe(true);
    expect(rows[0]?.versionTo).toBe(1);
  });

  it("emits two rows when deactivating a prior version", () => {
    const rows = buildActivationAuditRows({
      activatingVersion: 2,
      deactivatingVersion: 1,
      actor: ACTOR,
      reason: "promote v2",
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]?.versionTo).toBe(1);
    expect(rows[0]?.newValue).toBe(false);
    expect(rows[1]?.versionTo).toBe(2);
    expect(rows[1]?.newValue).toBe(true);
  });
});

function makePayload(): ConfigurationPayload {
  return {
    factorWeights: {
      additive: { days_since_last_contact: 1.5 },
      multiplicative_modifiers: {},
      overlap_caps: [],
    },
    tierThresholds: { tier1_min: 80, tier2_min: 50 },
    queuePredicates: {
      caseload_overview: {
        displayLabel: "Caseload overview",
        predicate: { kind: "all_active" },
        sortKey: "priority_score_desc",
        isDefault: true,
      },
    },
    barrierSeverityClassification: { "Cannot reach participant": "high" },
    barrierSeverityHigh: "3.00",
    barrierSeverityMedium: "2.00",
    barrierSeverityLow: "1.00",
    barrierStalenessMultiplier: "1.50",
    barrierStalenessThresholdDays: 30,
    tierInvariants: {
      failed_attempts_tier1_threshold: 3,
      barrier_type_to_invariant: {},
      open_repair_invariant: null,
      invariant_override_suppression: true,
    },

    dueStatusLeadTimeDays: 14,
    voucherRecertWarningDays: 30,
    recentIncidentWindowDays: 30,
    daysSinceContactScoringCapDays: 90,
    failedAttemptResetOnCompleted: true,
    recalibrationCadenceDays: 90,

    calibrationAlpha: "1.00",
    calibrationBeta: "2.00",
    calibrationThresholdPct: "85.00",
    calibrationParticipantsFloor: 10,

    sbopPath: "A",
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
    notes: null,
  };
}
