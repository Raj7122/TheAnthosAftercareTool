import { describe, expect, it } from "vitest";

import {
  configurationPayloadSchema,
  configurationSchema,
  factorWeightsSchema,
  queuePredicatesSchema,
  type ConfigurationPayload,
} from "../../src/config/index.js";

// VR-05 fail-loud reference (ERD §6.6 line 790). These tests prove the Zod
// schema rejects shapes that would cause the engine to misbehave at runtime.

describe("factorWeightsSchema (VR-05 fail-loud)", () => {
  it("accepts a well-formed factor_weights object", () => {
    const result = factorWeightsSchema.safeParse({
      additive: {
        days_since_last_contact: 1.5,
        failed_attempts: 2.0,
      },
      multiplicative_modifiers: {
        capacity_strain: 1.6,
      },
      overlap_caps: [
        { factors: ["failed_attempts", "days_since_last_contact"], cap: 3 },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects a non-numeric value in additive", () => {
    const result = factorWeightsSchema.safeParse({
      additive: { days_since_last_contact: "1.5" },
      multiplicative_modifiers: {},
      overlap_caps: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects overlap_caps that reference an unknown factor", () => {
    const result = factorWeightsSchema.safeParse({
      additive: { days_since_last_contact: 1.5 },
      multiplicative_modifiers: {},
      overlap_caps: [{ factors: ["unknown_factor"], cap: 3 }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.message.includes("unknown_factor"))).toBe(
        true,
      );
    }
  });

  it("rejects when required key 'additive' is missing", () => {
    const result = factorWeightsSchema.safeParse({
      multiplicative_modifiers: {},
      overlap_caps: [],
    });
    expect(result.success).toBe(false);
  });
});

describe("queuePredicatesSchema (F-04 BR-22 / FS-11 fail-loud)", () => {
  const validUniverse = {
    "caseload_overview": {
      displayLabel: "Caseload overview",
      predicate: { kind: "all_active" },
      sortKey: "priority_score_desc",
      isDefault: false,
    },
    "check_ins_due_this_month": {
      displayLabel: "Check-ins due this month",
      predicate: {
        kind: "successful_contact_overdue",
        params: { minDaysSinceContact: 28, currentCalendarMonthOnly: true },
      },
      sortKey: "priority_score_desc",
      isDefault: true,
    },
  };

  it("accepts a well-formed queue universe", () => {
    expect(queuePredicatesSchema.safeParse(validUniverse).success).toBe(true);
  });

  it("accepts the empty universe (pre-seed / transitional state)", () => {
    expect(queuePredicatesSchema.safeParse({}).success).toBe(true);
  });

  it("defaults sortKey to priority_score_desc when omitted (BR-21)", () => {
    const result = queuePredicatesSchema.safeParse({
      "caseload_overview": {
        displayLabel: "Caseload overview",
        predicate: { kind: "all_active" },
        isDefault: true,
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data["caseload_overview"]?.sortKey).toBe(
        "priority_score_desc",
      );
    }
  });

  it("rejects an unknown predicate kind", () => {
    const result = queuePredicatesSchema.safeParse({
      bogus: {
        displayLabel: "Bogus",
        predicate: { kind: "not_a_real_kind" },
        isDefault: true,
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown predicate param key", () => {
    const result = queuePredicatesSchema.safeParse({
      "due_soon": {
        displayLabel: "Due soon",
        predicate: { kind: "due_within_days", params: { days: 30, weeks: 1 } },
        isDefault: true,
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-positive due_within_days threshold", () => {
    const result = queuePredicatesSchema.safeParse({
      "due_soon": {
        displayLabel: "Due soon",
        predicate: { kind: "due_within_days", params: { days: 0 } },
        isDefault: true,
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown field on a queue entry", () => {
    const result = queuePredicatesSchema.safeParse({
      "caseload_overview": {
        displayLabel: "Caseload overview",
        predicate: { kind: "all_active" },
        isDefault: true,
        color: "blue",
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a queue id longer than 100 chars (caseload_cache.queue_id ceiling)", () => {
    const result = queuePredicatesSchema.safeParse({
      ["q".repeat(101)]: {
        displayLabel: "Id too long",
        predicate: { kind: "all_active" },
        isDefault: true,
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a displayLabel longer than 80 chars", () => {
    const result = queuePredicatesSchema.safeParse({
      "caseload_overview": {
        displayLabel: "x".repeat(81),
        predicate: { kind: "all_active" },
        isDefault: true,
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-empty universe with two default queues", () => {
    const result = queuePredicatesSchema.safeParse({
      ...validUniverse,
      "caseload_overview": {
        ...validUniverse["caseload_overview"],
        isDefault: true,
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((i) => i.message.includes("exactly one")),
      ).toBe(true);
    }
  });

  it("rejects a non-empty universe with no default queue", () => {
    const result = queuePredicatesSchema.safeParse({
      "caseload_overview": {
        displayLabel: "Caseload overview",
        predicate: { kind: "all_active" },
        isDefault: false,
      },
    });
    expect(result.success).toBe(false);
  });
});

describe("configurationPayloadSchema", () => {
  it("accepts a payload that omits row metadata", () => {
    const payload: ConfigurationPayload = makeValidPayload();
    expect(configurationPayloadSchema.safeParse(payload).success).toBe(true);
  });

  it("rejects sbop_path outside the 'A' | 'B' | 'C' enum", () => {
    const payload = { ...makeValidPayload(), sbopPath: "D" };
    expect(configurationPayloadSchema.safeParse(payload).success).toBe(false);
  });
});

describe("configurationSchema (full row)", () => {
  it("accepts a hydrated row with metadata + payload", () => {
    const row = {
      version: 1,
      isActive: true,
      createdAt: new Date(),
      createdBy: "admin",
      activationAt: new Date(),
      deactivatedAt: null,
      ...makeValidPayload(),
    };
    expect(configurationSchema.safeParse(row).success).toBe(true);
  });

  it("rejects a row missing factor_weights.additive", () => {
    const row = {
      version: 1,
      isActive: false,
      createdAt: new Date(),
      createdBy: "admin",
      activationAt: null,
      deactivatedAt: null,
      ...makeValidPayload(),
      factorWeights: {
        multiplicative_modifiers: {},
        overlap_caps: [],
      },
    };
    expect(configurationSchema.safeParse(row).success).toBe(false);
  });
});

// P1E-03 — BR-19(e) / BR-37 / BR-39 / VR-05 / AC-15. The five new severity
// + staleness fields are required at parse time so the engine refuses to
// start on missing or non-numeric values.
describe("barrier severity + staleness config (VR-05 / AC-15)", () => {
  for (const key of [
    "barrierSeverityHigh",
    "barrierSeverityMedium",
    "barrierSeverityLow",
    "barrierStalenessMultiplier",
  ] as const) {
    it(`rejects ${key} missing`, () => {
      const payload = { ...makeValidPayload() } as Record<string, unknown>;
      // eslint-disable-next-line security/detect-object-injection -- typed `key` from `as const` array
      delete payload[key];
      expect(configurationPayloadSchema.safeParse(payload).success).toBe(false);
    });

    it(`rejects ${key} when non-numeric string`, () => {
      const payload = { ...makeValidPayload(), [key]: "high" };
      expect(configurationPayloadSchema.safeParse(payload).success).toBe(false);
    });
  }

  it("rejects barrierStalenessThresholdDays when missing", () => {
    const payload = { ...makeValidPayload() } as Record<string, unknown>;
    delete payload.barrierStalenessThresholdDays;
    expect(configurationPayloadSchema.safeParse(payload).success).toBe(false);
  });

  it("rejects barrierStalenessThresholdDays when negative", () => {
    const payload = {
      ...makeValidPayload(),
      barrierStalenessThresholdDays: -1,
    };
    expect(configurationPayloadSchema.safeParse(payload).success).toBe(false);
  });

  it("rejects barrierStalenessThresholdDays when non-integer", () => {
    const payload = {
      ...makeValidPayload(),
      barrierStalenessThresholdDays: 30.5,
    };
    expect(configurationPayloadSchema.safeParse(payload).success).toBe(false);
  });

  // P0-14 — `.default(90)` lets a configuration row written before migration
  // 0012 added the column still parse (the column is NOT NULL DEFAULT 90, so
  // post-migration rows always carry it; this covers the transitional read).
  it("backfills daysSinceContactScoringCapDays to 90 when omitted", () => {
    const withoutCap: Record<string, unknown> = { ...makeValidPayload() };
    delete withoutCap.daysSinceContactScoringCapDays;
    const parsed = configurationPayloadSchema.parse(withoutCap);
    expect(parsed.daysSinceContactScoringCapDays).toBe(90);
  });

  it("rejects daysSinceContactScoringCapDays when not a positive integer", () => {
    expect(
      configurationPayloadSchema.safeParse({
        ...makeValidPayload(),
        daysSinceContactScoringCapDays: 0,
      }).success,
    ).toBe(false);
  });
});

function makeValidPayload(): ConfigurationPayload {
  return {
    factorWeights: {
      additive: { days_since_last_contact: 1.5 },
      multiplicative_modifiers: {},
      overlap_caps: [],
    },
    tierThresholds: { tier1_min: 80, tier2_min: 50 },
    queuePredicates: {
      "caseload_overview": {
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
