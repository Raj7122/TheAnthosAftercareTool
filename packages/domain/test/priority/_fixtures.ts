import type { Configuration } from "../../src/config/index.js";
import type {
  Factor,
  FactorComputeResult,
  HydratedParticipant,
  SuppressionState,
} from "../../src/priority/index.js";

// Shared test fixtures for priority/* tests. Mirrors makeValidPayload() in
// config/schema.test.ts; expanded to include row metadata + the engine-
// relevant fields. Adjusting one fixture keeps all tests in sync.

export function makeConfig(
  overrides: Partial<Configuration> = {},
): Configuration {
  return {
    version: 7,
    isActive: true,
    createdAt: new Date("2026-01-15T00:00:00Z"),
    createdBy: "admin",
    activationAt: new Date("2026-01-15T00:00:00Z"),
    deactivatedAt: null,

    factorWeights: {
      additive: {
        days_since_last_contact: 1.5,
        failed_attempts: 4.0,
      },
      multiplicative_modifiers: {},
      overlap_caps: [],
    },
    tierThresholds: { tier1_min: 80, tier2_min: 50 },
    queuePredicates: {},
    barrierSeverityClassification: {},
    // P1E-03 — defaults preserve the prior hardcoded ordinal calibration math
    // (3/2/1). Tests that exercise the BR-39 staleness multiplier or alternate
    // severity weights override these fields explicitly.
    barrierSeverityHigh: "3.00",
    barrierSeverityMedium: "2.00",
    barrierSeverityLow: "1.00",
    barrierStalenessMultiplier: "1.50",
    barrierStalenessThresholdDays: 30,
    // High BR-24 threshold keeps existing tests from accidentally tripping the
    // Tier 1 floor; suites that exercise the floor override this field.
    // P0-04b — default override direction = true; tests that exercise the
    // reversed direction override this block.
    tierInvariants: {
      failed_attempts_tier1_threshold: 999,
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
    ...overrides,
  };
}

export function makeParticipant(
  overrides: Partial<HydratedParticipant> = {},
): HydratedParticipant {
  return {
    participantId: "0035g00000ABCDEAA1",
    hydratedAt: new Date("2026-05-18T12:00:00Z"),
    ...overrides,
  };
}

// P0-04b — helper for TR-PRIORITY-18 tests. The engine treats absence of
// `suppression` on EngineInput as "not snoozed", so the negative case is
// just `suppression: undefined` (no fixture). When you DO want snoozed,
// call this helper; overrides only target `snoozedUntil` because `state`
// is a constant in the current API shape.
export function makeSuppression(
  overrides: Partial<Omit<SuppressionState, "state">> = {},
): SuppressionState {
  return {
    state: "snoozed",
    snoozedUntil: new Date("2026-06-01T00:00:00Z"),
    ...overrides,
  };
}

// makeFactor — builds a Factor that returns the supplied valueNumeric.
// Tests pass a deterministic value so we can assert against arithmetic.
// The compute() callback accepts the post-P0-04 (participant, configuration)
// signature but ignores both — value comes from `opts.valueNumeric`.
export function makeFactor(opts: {
  key: string;
  valueNumeric: number;
  valueLabel?: string;
  displayName?: string;
  type?: "numeric" | "categorical";
}): Factor {
  return {
    key: opts.key,
    displayName: opts.displayName ?? opts.key,
    type: opts.type ?? "numeric",
    compute(): FactorComputeResult {
      return {
        valueLabel: opts.valueLabel ?? `${opts.valueNumeric}`,
        valueNumeric: opts.valueNumeric,
      };
    },
  };
}

// BR-19 canonical factor keys per TRD v1.8 §TR-PRIORITY-8. The TRD lists
// factors (a)–(j). Factor (g) "Arrears state" landed in P0-08c against the
// dedicated Arrear__c object (Q14 closed by P0-08b) — registered now, but
// Pattern F at config weight 0 until the FS §F-03 erratum + P0-14. Factor
// (j) "Confirmed AI-extracted signals" was added v1.7/v1.11 per F-20 and is
// a Phase 3D / M-AI deliverable; the (j) factor function lands with the
// M-AI sidecar. Engine routing is letter-agnostic — this list exists so the
// per-factor breakdown test exercises every named key.
//
// If a future factor picks different snake_case names, rebase here and
// align — do NOT keep two naming conventions live.
export const BR19_FACTOR_KEYS = [
  "days_since_last_contact", // (a)
  "stability_visit_state", // (b)
  "failed_attempts", // (c)
  "recent_incident", // (d)
  "open_barriers", // (e)
  "unit_engagement", // (f)
  "arrears", // (g) — added P0-08c; Pattern F, config weight 0
  "aftercare_extended", // (h) — added v1.8 per Julia
  "voucher_recert_deadline", // (i) — added v1.8 per Julia; GAP-17
  "confirmed_ai_signals", // (j) — added v1.7/v1.11 per F-20; Phase 3D / M-AI
] as const;

export type BR19FactorKey = (typeof BR19_FACTOR_KEYS)[number];

// makeAllBR19Factors — returns one stub Factor per BR-19 key. Default
// valueNumeric=1 for every factor; pass `values` to override any subset.
// Used to exercise the engine's per-factor routing without requiring the
// real P0-04 factor logic.
export function makeAllBR19Factors(
  values: Partial<Record<BR19FactorKey, number>> = {},
): Factor[] {
  return BR19_FACTOR_KEYS.map((key) =>
    // eslint-disable-next-line security/detect-object-injection -- typed BR19FactorKey lookup
    makeFactor({ key, valueNumeric: values[key] ?? 1 }),
  );
}

// makeBR19Config — Configuration that declares an additive
// weight for every BR-19 key plus `sbop`. Weights chosen as 1.0 for
// reproducible arithmetic; override via `overrides.factorWeights.additive`
// when a test needs different weights.
export function makeBR19Config(
  overrides: Partial<Configuration> = {},
): Configuration {
  const additive: Record<string, number> = { sbop: 1.0 };
  for (const key of BR19_FACTOR_KEYS) {
    // eslint-disable-next-line security/detect-object-injection -- typed BR19FactorKey write
    additive[key] = 1.0;
  }

  return makeConfig({
    factorWeights: {
      additive,
      multiplicative_modifiers: {},
      overlap_caps: [],
    },
    ...overrides,
  });
}
