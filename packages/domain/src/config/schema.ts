import { z } from "zod";

// ERD v1.4 §6.6 — structured `factor_weights`:
//   { additive: { [factorKey]: number },
//     multiplicative_modifiers: { [modifierKey]: number },
//     overlap_caps: [{ factors: string[], cap: number }] }
// VR-05 fail-loud (ERD §6.6 line 790): every overlap_caps[].factors entry
// MUST reference a key present in `additive`. Enforced via .superRefine below.
export const factorWeightsSchema = z
  .object({
    additive: z.record(z.string(), z.number().finite()),
    multiplicative_modifiers: z.record(z.string(), z.number().finite()),
    overlap_caps: z.array(
      z.object({
        factors: z.array(z.string()).min(1),
        cap: z.number().finite(),
      }),
    ),
  })
  .strict()
  .superRefine((value, ctx) => {
    const known = new Set(Object.keys(value.additive));
    value.overlap_caps.forEach((entry, entryIndex) => {
      entry.factors.forEach((factor, factorIndex) => {
        if (!known.has(factor)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `overlap_caps[${entryIndex}].factors[${factorIndex}]='${factor}' is not declared in additive`,
            path: ["overlap_caps", entryIndex, "factors", factorIndex],
          });
        }
      });
    });
  });

export type FactorWeights = z.infer<typeof factorWeightsSchema>;

// Tier thresholds: numeric score cutoffs between tiers. Stored as
// { tier1_min: number, tier2_min: number, ... } so callers can add tiers
// without a schema change.
export const tierThresholdsSchema = z
  .record(z.string().regex(/^tier\d+_min$/), z.number().finite())
  .refine((value) => Object.keys(value).length > 0, {
    message: "tier_thresholds must declare at least one tier cutoff",
  });

export type TierThresholds = z.infer<typeof tierThresholdsSchema>;

// Queue predicates (TR-QUEUE-1, F-04 BR-22): the named-queue universe. Each entry
// is one work queue — its id (the record key), display label, predicate, sort key,
// and default-landing flag. BR-22 requires the universe to be configuration-driven
// so it can be tuned without a code change; FS-11 requires a misconfigured
// predicate to fail loud (a VR-05 analog) — hence the strict, discriminated shapes
// below. P1C-01 evaluates these predicates; P1C-04 renders the labels and counts.
//
// A predicate is a named `kind` plus its tunable params. The four `kind`s map 1:1
// to the four spec'd queues (FS v1.12 F-04 BR-22, lines 583-586). Tuning the
// thresholds (days / minFailedAttempts) is a config change; adding a brand-new
// `kind` is a code change — acceptable, as the queue universe is engineer-
// maintained for Demo. `params` objects are `.strict()`, so an unknown or
// misspelled key fails parsing rather than being silently ignored.
export const queuePredicateSchema = z.discriminatedUnion("kind", [
  // BR-22 "Caseload overview": all active participants in the caseload. The
  // hydrated caseload is already scoped to the specialist's active participants,
  // so this predicate admits every row (VR-08: caseload overview always qualifies).
  z.object({ kind: z.literal("all_active") }).strict(),
  // BR-22 "Due soon": a monthly check-in OR a stability-visit checkpoint due
  // within `days` days. EC-13: a participant 31 days out is excluded.
  z
    .object({
      kind: z.literal("due_within_days"),
      params: z.object({ days: z.number().int().positive() }).strict(),
    })
    .strict(),
  // BR-22 "Never successfully contacted": at least `minFailedAttempts` failed
  // contact attempts AND zero successful contacts ever.
  z
    .object({
      kind: z.literal("never_successfully_contacted"),
      params: z
        .object({ minFailedAttempts: z.number().int().nonnegative() })
        .strict(),
    })
    .strict(),
  // BR-22 "Check-ins due this month": the `Most Recent Successful Contact` is at
  // least `minDaysSinceContact` days old AND (when `currentCalendarMonthOnly`) a
  // check-in falls due within the current calendar month.
  z
    .object({
      kind: z.literal("successful_contact_overdue"),
      params: z
        .object({
          minDaysSinceContact: z.number().int().nonnegative(),
          currentCalendarMonthOnly: z.boolean(),
        })
        .strict(),
    })
    .strict(),
]);

export type QueuePredicate = z.infer<typeof queuePredicateSchema>;

// One work queue. BR-21 fixes within-queue ordering to priority score descending
// for every queue, so `sortKey` is a single-value enum today — a forward-compat
// hook, not a tuning surface. Exactly one queue in the universe carries
// `isDefault: true` — enforced by the refinement on `queuePredicatesSchema`.
export const queueEntrySchema = z
  .object({
    displayLabel: z.string().min(1).max(80),
    predicate: queuePredicateSchema,
    sortKey: z.enum(["priority_score_desc"]).default("priority_score_desc"),
    isDefault: z.boolean(),
    // Optional authoring note — why this queue exists / how to tune it.
    description: z.string().optional(),
  })
  .strict();

export type QueueEntry = z.infer<typeof queueEntrySchema>;

// The queue universe: queue id -> entry. The id is the record key; it is also the
// P1C-02 cache-key `queue_id` and P1C-01's `?queue=` value, so it must be a stable
// URL-safe slug (<= 100 chars, per the `caseload_cache.queue_id` column). FS-11
// fail-loud: a non-empty universe MUST declare exactly one default queue. The
// empty universe `{}` is permitted for pre-seed / transitional states.
export const queuePredicatesSchema = z
  .record(z.string().min(1).max(100), queueEntrySchema)
  .superRefine((queues, ctx) => {
    const entries = Object.values(queues);
    if (entries.length === 0) {
      return;
    }
    const defaultCount = entries.filter((queue) => queue.isDefault).length;
    if (defaultCount !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `queue_predicates must declare exactly one default queue (isDefault: true); found ${defaultCount}`,
        // The violation is a property of the whole universe, not one queue —
        // attach at the record root (cf. factorWeightsSchema's deep path).
        path: [],
      });
    }
  });

export type QueuePredicates = z.infer<typeof queuePredicatesSchema>;

// Barrier severity classification (BR-37, F-06): map Barrier Type label to
// severity tier. Stored as { [barrierTypeLabel]: 'high' | 'medium' | 'low' }.
export const barrierSeveritySchema = z.enum(["high", "medium", "low"]);

export const barrierSeverityClassificationSchema = z.record(
  z.string().min(1),
  barrierSeveritySchema,
);

export type BarrierSeverityClassification = z.infer<
  typeof barrierSeverityClassificationSchema
>;

// BR-19(e) / F-06 BR-37 — numeric severity weights consumed by the
// open_barriers factor. Per FS v1.12 §F-03 BR-19(f) the spec carries these
// as configuration variables (`barrier_severity_high/medium/low`); concrete
// values land in v1.9 once Julia approves `barrier_severity_classification_draft.md`.
// Stored as Postgres numeric(5,2) — Drizzle hands the value back as a string
// (matches `capacityStrainMultiplier` precedent). `.refine` rejects non-numeric
// strings at parse time so a missing or malformed entry fails the engine loud
// per VR-05 / AC-15 (TRD §1786, FS §558). The open_barriers factor coerces via
// `Number(...)` after the refine has guaranteed finiteness.
//
// BR-39 — `Days Since Last Update` formula on Barriers acts as a staleness
// multiplier (FS §723): barriers untouched for ≥ thresholdDays receive the
// configured multiplier on their per-Barrier contribution. Spec calls 30 days
// out as the threshold; both the multiplier and threshold are tunable from
// M-CONFIG so calibration can refine without code change.
const finiteNumericString = z
  .string()
  .refine((v) => Number.isFinite(Number(v)), {
    message: "must be a finite numeric string",
  });

export const barrierSeverityWeightSchema = finiteNumericString;
export const barrierStalenessMultiplierSchema = finiteNumericString;
export const barrierStalenessThresholdDaysSchema = z.number().int().nonnegative();

// Categorical Tier 1 invariant configuration (BR-24/25/26, TR-PRIORITY-15/16/17).
//   - `failed_attempts_tier1_threshold`: BR-24 N (FS v1.12:515 starting value 3).
//   - `barrier_type_to_invariant`: BR-26 — keyed by Salesforce Barrier Type
//     label. Demo Mode seed is `{}` (BR-26 never fires); fail-loud at engine
//     construction if any key is absent from the SF picklist enum cache.
//   - `open_repair_invariant`: BR-25 — pivoted off the Barriers picklist onto
//     the dedicated `Repair__c` object (P0-04e; Julia 2026-05-19). `null` keeps
//     it dark (Demo Mode seed); a `{ invariant_id, display_label }` block
//     constructs the invariant. Pattern F — even when constructed it fires only
//     once `Repair__c` hydration is projected onto the participant. Unlike
//     `barrier_type_to_invariant` it has no enum-cache fail-loud: it no longer
//     depends on the Barrier Type picklist.
//   - `invariant_override_suppression` (P0-04b, TR-PRIORITY-18): when an
//     invariant fires for a participant in BR-21 Path C "Snoozed" state,
//     does the invariant override the suppression? Default `true` per
//     TRD v1.8 §451. Calibration (P0-13b/P0-14) may reverse via M-CONFIG.
//
// The persistence-layer jsonb column default may omit `open_repair_invariant`
// and `invariant_override_suppression` — Zod backfills them on read via the
// `.default(...)` clauses below, so the stored default is allowed to be a
// subset of this schema (it already omits `invariant_override_suppression`).
export const tierInvariantsSchema = z
  .object({
    failed_attempts_tier1_threshold: z.number().int().nonnegative(),
    barrier_type_to_invariant: z.record(
      z.string().min(1),
      z
        .object({
          invariant_id: z.string().min(1),
          display_label: z.string().min(1),
        })
        .strict(),
    ),
    open_repair_invariant: z
      .object({
        invariant_id: z.string().min(1),
        display_label: z.string().min(1),
      })
      .strict()
      .nullable()
      .default(null),
    invariant_override_suppression: z.boolean().default(true),
  })
  .strict();

export type TierInvariantsConfig = z.infer<typeof tierInvariantsSchema>;

// Per-row Configuration shape — mirrors `configuration` table columns (ERD §6.6).
// Dates land as Date instances after Drizzle hydration; non-jsonb columns are
// preserved as their native types so callers can index without re-parsing.
export const configurationSchema = z
  .object({
    version: z.number().int().positive(),
    isActive: z.boolean(),
    createdAt: z.date(),
    createdBy: z.string().min(1).max(50),
    activationAt: z.date().nullable(),
    deactivatedAt: z.date().nullable(),

    factorWeights: factorWeightsSchema,
    tierThresholds: tierThresholdsSchema,
    queuePredicates: queuePredicatesSchema,
    barrierSeverityClassification: barrierSeverityClassificationSchema,
    // BR-19(e) / BR-37 — per-tier severity weights; BR-39 staleness control.
    barrierSeverityHigh: barrierSeverityWeightSchema,
    barrierSeverityMedium: barrierSeverityWeightSchema,
    barrierSeverityLow: barrierSeverityWeightSchema,
    barrierStalenessMultiplier: barrierStalenessMultiplierSchema,
    barrierStalenessThresholdDays: barrierStalenessThresholdDaysSchema,
    tierInvariants: tierInvariantsSchema,

    dueStatusLeadTimeDays: z.number().int(),
    voucherRecertWarningDays: z.number().int(),
    recentIncidentWindowDays: z.number().int(),
    // BR-19(a) — scoring cap (in days) on the days-since-last-contact factor.
    // Caps the per-factor value so it lands on a real operational boundary
    // (90 = quarterly visit cadence) rather than flooding the score: a 67-day
    // gap contributes 67, a 120-day gap contributes 90, and the never-contacted
    // (BR-15) case maps to this same ceiling instead of a runaway sentinel.
    // `.default(90)` backfills DB rows written before migration 0012 added the
    // column, so a row that omits it still parses (cf. tierInvariants defaults).
    daysSinceContactScoringCapDays: z.number().int().positive().default(90),
    failedAttemptResetOnCompleted: z.boolean(),
    recalibrationCadenceDays: z.number().int(),

    calibrationAlpha: z.string(),
    calibrationBeta: z.string(),
    calibrationThresholdPct: z.string(),
    calibrationParticipantsFloor: z.number().int(),

    sbopPath: z.enum(["A", "B", "C"]),
    sbopSuppressionDays: z.number().int(),
    sbopEnabled: z.boolean(),

    capacityStrainMultiplier: z.string(),
    capacityStrainPersistenceDays: z.number().int(),

    quietHoursStartLocal: z.string(),
    quietHoursEndLocal: z.string(),

    mogliTimeoutSeconds: z.number().int(),
    mogliBackoffSeconds: z.array(z.number().int()),

    offlineMaxQueueDepth: z.number().int(),
    offlineMaxRetries: z.number().int(),
    idempotencyTtlHours: z.number().int(),
    hardRefreshRateLimitSeconds: z.number().int(),

    nightlyRefreshCron: z.string(),
    weeklyDigestCron: z.string(),
    dailyDigestCron: z.string(),

    tieBreakerStrategy: z.string(),

    featureFlags: z.record(z.string(), z.unknown()),
    approvalMetadata: z.unknown().nullable(),
    notes: z.string().nullable(),
  })
  .strict();

export type Configuration = z.infer<typeof configurationSchema>;

// Payload shape for createConfiguration: everything that an admin can set on a
// new version. Metadata columns (version, isActive, timestamps, createdBy) are
// assigned by the repository, not the caller.
export const configurationPayloadSchema = configurationSchema.omit({
  version: true,
  isActive: true,
  createdAt: true,
  createdBy: true,
  activationAt: true,
  deactivatedAt: true,
});

export type ConfigurationPayload = z.infer<typeof configurationPayloadSchema>;
