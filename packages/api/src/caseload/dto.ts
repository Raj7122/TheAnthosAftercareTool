// Caseload wire DTO assembly (P1C-01, E-06; F-02 + F-04).
//
// Builds the E-06 response body from the engine-scored caseload. P1H-01 split
// the wire shape from the cache payload: `CaseloadItem` is the HTTP response
// shape and now carries `displayName` (PII). The cache write-through must
// route the body through `stripPiiForCache` first, which nulls the PII fields
// so the `caseload_cache` payload stays PII-free per Immutable #1 (and the
// PII contract at `caseload-cache.ts:15-19`). Warm-cache reads therefore
// return `displayName: null`; the SPA handles the gap.
//
// Still deferred to a later ticket: `enrollmentCode`, `preferredContactMethod`,
// `communicationConsent`. The P0-08 hydrate path now fetches `Contact__r.Name`
// for displayName; the other PII fields stay out until a feature needs them.

import {
  computeCheckpointState,
  computePerCheckpointStates,
  deriveRowTags,
  type CheckpointAnchor,
  type CheckpointState,
  type Configuration,
  type EngineOutput,
  type FactorContribution,
  type HighestImpactFactor,
  type PerAnchorState,
  type RowTag,
  type RowTagSnapshot,
  type TriggeredInvariant,
} from "@anthos/domain";
import type {
  BarrierSnapshot,
  CaseloadSnapshot,
  EnrollmentSnapshot,
} from "@anthos/integrations";

import { toIsoDate, wholeDaysBetween } from "./dates.js";
import type { ScoredParticipant } from "./score-caseload.js";

// One row of the per-factor breakdown (API v1.3 §7.3.1). The engine's
// `weightRaw` is dropped at the wire boundary; `trend` is omitted — the engine
// does not compute it.
//
// P1H-13b: `key` is now exposed on the wire so the SPA can switch on a stable
// identifier when rendering the "firing factor" sentence (display labels are
// brittle for that use). `key` is not PII; `stripPiiForCache` is unchanged.
export interface CaseloadFactor {
  readonly key: string;
  readonly name: string;
  readonly valueLabel: string;
  readonly valueNumeric: number;
  readonly weight: string;
  readonly pointsContributed: number;
}

// The TR-PRIORITY-7 v1.2 breakdown payload's invariant arm. Snake_case wire
// keys; `triggering_record_id` is OMITTED (not null) for aggregate invariants
// like BR-24 that have no single triggering record.
export interface CaseloadTriggeredInvariant {
  readonly invariant_id: string;
  readonly display_label: string;
  readonly triggering_record_id?: string;
}

export interface CaseloadHighestImpactFactor {
  readonly key: string;
  readonly name: string;
  readonly valueLabel: string;
  readonly weight: string;
  readonly pointsContributed: number;
}

// The embedded Stability Visit summary (API v1.3 §7.3.1, AC-18).
//
// LIMITATION (flagged in the PR): the P0-08 snapshot carries no per-checkpoint
// Stability-Meeting credit, so only `on_track` / `upcoming` are derivable —
// `missed` / `catchup` / `overdue` are not (see `snapshot-projection.ts`
// `deriveStabilityVisitState`). `checkpoint` (no checkpoint index in the
// snapshot) and `scheduledVisitDateTime` (not hydrated) are always `null`.
export interface CaseloadStabilityVisit {
  readonly status: "on_track" | "upcoming";
  readonly statusLabel: string;
  readonly nextDueDate: string | null;
  readonly checkpoint: number | null;
  readonly completedCount: number | null;
  readonly missedCount: number | null;
  readonly scheduledVisitDateTime: string | null;
}

// F-05 stability-visit cycle status — the per-row badge surface (P1D-04).
// Wire-safe projection of `ComputeCheckpointStateOutput` so this DTO stays
// self-contained per the module pattern (`tier` / `tierLabel` are likewise
// projected from `EngineOutput`).
//
// LIMITATION: `completedStabilityMeetings` is passed as `[]` until a
// follow-up ticket hydrates per-visit service dates — the SF snapshot
// carries only lifetime check-in rollups (monthly cadence), not the
// quarterly Stability Meeting Case Notes that BR-25 credits. Until then,
// cycle state reflects calendar position only. See ticket P1D-04.
export interface CaseloadCycleStatus {
  readonly state: CheckpointState;
  readonly daysToNext: number | null;
  readonly daysOverdue: number;
  readonly nextCheckpoint: CheckpointAnchor | null;
  readonly lastCreditedCheckpoint: CheckpointAnchor | null;
}

// F-05 BR-26 Option A — per-anchor breakdown row (P1F-07). One entry per
// checkpoint anchor (90/180/270/365) for the F-07 detail-page breakdown
// panel. Wire-safe projection of `PerCheckpointBreakdown` from @anthos/domain
// — keeps the SPA on the @anthos/api type surface per the bundle-discipline
// memo (value imports from @anthos/api drag `pg` into the client chunk;
// type-only is safe).
export interface PerCheckpointBreakdownDto {
  readonly anchor: CheckpointAnchor;
  readonly state: PerAnchorState;
}

export interface CaseloadOpenBarrier {
  readonly barrierId: string;
  readonly type: string | null;
  readonly severity: "high" | "medium" | "low" | null;
  readonly openedAt: string | null;
  readonly ageDays: number | null;
}

// One caseload row — engine core + snapshot-derived blocks.
// Engine-core fields are `null` on a degraded row (a factor or the projection
// threw); `dataIssues` then carries `degraded_score`. `displayName` is PII —
// see the file-level comment + `stripPiiForCache` below; the cache write path
// nulls it before persistence.
export interface CaseloadItem {
  readonly participantId: string;
  // P1H-01 — F-02 row display fields. `displayName` is PII (stripped at
  // cache); `peLabel` (PE date suffix, e.g., "09/2023") and `programCode`
  // (raw `Client_Type__c`, e.g., "ACS" or "ACS;HHN") are cache-safe.
  readonly displayName: string | null;
  readonly peLabel: string | null;
  readonly programCode: string | null;
  readonly aftercareDay: number | null;
  // P3D-01 (F-23) — ISO `YYYY-MM-DD` Aftercare start date. The caseload
  // activity calendar plots stability checkpoints across all participants
  // (start + 90/180/270/365 days), the same arithmetic the per-participant
  // calendar uses from the detail body. A bare date is not PII;
  // `stripPiiForCache` leaves it intact (see the strip helper below).
  readonly aftercareStartDate: string | null;
  readonly tier: number | null;
  readonly tierLabel: string | null;
  readonly priorityScore: number | null;
  readonly priorityModifier: string | null;
  readonly highestImpactFactor: CaseloadHighestImpactFactor | null;
  readonly factors: ReadonlyArray<CaseloadFactor>;
  // P1H-04 — second-highest-impact factor name for the wireframe's two-line
  // "Why this priority" column. Derived from `engine.factors` (see
  // `deriveSecondaryFactorLabel`); `null` when the row has fewer than two
  // non-zero-impact factors, or on degraded rows. Presentation-only — the
  // engine's score and primary-factor label remain the sources of truth.
  readonly secondaryFactorLabel: string | null;
  readonly triggered_invariants: ReadonlyArray<CaseloadTriggeredInvariant>;
  readonly lastSuccessfulContactDaysAgo: number | null;
  readonly stabilityVisit: CaseloadStabilityVisit;
  readonly cycleStatus: CaseloadCycleStatus;
  readonly perCheckpointBreakdown: ReadonlyArray<PerCheckpointBreakdownDto>;
  readonly openBarriers: ReadonlyArray<CaseloadOpenBarrier>;
  // P1H-03 — severity-coded chips for the wireframe "Barriers / Tags" column.
  // Derived from snapshot fields via `deriveRowTags`; the SPA (P1H-05) maps
  // each `RowTag.severity` to a CSS variant. Empty on degraded rows.
  readonly tags: ReadonlyArray<RowTag>;
  // P1H-14 — BR-19(h) Aftercare Extended program-modifier badge for the
  // PARTICIPANT cell. Sourced from `EnrollmentSnapshot.aftercareExtended`,
  // itself derived from `Aftercare_Extension_End_Date__c` per P0-08a (SF
  // object has no literal `Aftercare_Extended__c` checkbox; derivation:
  // extensionEnd != null && (aftercareEnd == null || extensionEnd > aftercareEnd)).
  // Spec-aligned shape: FS v1.12 BR-19(h) names this a boolean modifier,
  // not a multi-value picklist — kept narrow until a second modifier lands.
  // Not PII; `stripPiiForCache` unchanged.
  readonly aftercareExtended: boolean;
  // P1H-10 — Path C SBOP suppression state. ALWAYS `null` today (Pattern F
  // stub; BR-21 / GAP-9 unratified, upstream detection ticket not yet built).
  // Wire shape mirrors `PathCSuppressionState` from `@anthos/domain` but
  // dates are serialized as ISO strings for the HTTP boundary. The SPA's
  // CaseloadRow renders the "Seen by Other Provider" treatment when
  // `pathCSuppression?.active === true`; today that branch is dead code.
  // Provider name + reason are display-only — they MUST NOT enter audit
  // metadata or any persisted record outside Salesforce (PII firewall).
  readonly pathCSuppression: {
    readonly active: boolean;
    readonly reason: string | null;
    readonly seenAt: string | null;
    readonly provider: string | null;
  } | null;
  readonly voucherRecertDays: number | null;
  readonly dataIssues: ReadonlyArray<string>;
}

// The E-06 response envelope. `sort` is fixed to `priority_desc`: BR-21 makes
// within-queue ordering priority-score-descending for every queue.
export interface CaseloadBody {
  readonly specialistId: string;
  readonly queue: string;
  readonly sort: "priority_desc";
  readonly queueCounts: Record<string, number>;
  readonly cacheAgeSeconds: number;
  readonly configurationVersion: number;
  readonly items: ReadonlyArray<CaseloadItem>;
}

// Builds one PII-free caseload row from a scored participant.
export function buildCaseloadItem(
  scored: ScoredParticipant,
  configuration: Configuration,
  now: Date,
): CaseloadItem {
  const { snapshot, engine, degraded } = scored;
  const enr = snapshot.enrollment;

  const stabilityVisit = buildStabilityVisit(enr, configuration, now);
  const cycleStatus = buildCycleStatus(enr, now);
  const perCheckpointBreakdown = buildPerCheckpointBreakdown(enr, now);
  const openBarriers = buildOpenBarriers(snapshot.barriers, configuration, now);
  const voucherRecertDays =
    enr.voucherRecertDeadline === null
      ? null
      : wholeDaysBetween(now, enr.voucherRecertDeadline);
  // P1H-03 — chips are presentation-derived from the same snapshot fields that
  // back the BR-19 factors; the engine and the chip cluster never disagree
  // about whether a signal is present. Degraded rows (engine threw) emit `[]`
  // per the ticket DoD — the snapshot may still be partially populated, but a
  // row whose score we can't trust should not advertise its signals.
  const tags = degraded
    ? []
    : deriveRowTags(
        buildRowTagSnapshot({
          enrollment: enr,
          snapshot,
          perCheckpointBreakdown,
          voucherRecertDays,
          configuration,
        }),
        now,
      );

  return {
    participantId: snapshot.participantId,
    displayName: enr.displayName,
    peLabel: extractPeLabel(enr.peName),
    programCode: enr.programCode,
    aftercareDay:
      enr.aftercareStartDate === null
        ? null
        : wholeDaysBetween(enr.aftercareStartDate, now),
    aftercareStartDate:
      enr.aftercareStartDate === null ? null : toIsoDate(enr.aftercareStartDate),
    tier: engine?.tier ?? null,
    tierLabel: engine?.tierLabel ?? null,
    priorityScore: engine?.priorityScore ?? null,
    priorityModifier: engine?.priorityModifier ?? null,
    highestImpactFactor:
      engine === null ? null : adaptHighestImpact(engine.highestImpactFactor),
    factors: engine === null ? [] : engine.factors.map(adaptFactor),
    secondaryFactorLabel: deriveSecondaryFactorLabel(engine),
    triggered_invariants:
      engine === null ? [] : engine.triggeredInvariants.map(adaptInvariant),
    lastSuccessfulContactDaysAgo:
      enr.mostRecentSuccessfulContact === null
        ? null
        : wholeDaysBetween(enr.mostRecentSuccessfulContact, now),
    stabilityVisit,
    cycleStatus,
    perCheckpointBreakdown,
    openBarriers,
    tags,
    aftercareExtended: enr.aftercareExtended,
    // P1H-10 stub: always null. Replace with a real projection in P1H-10b
    // once BR-21 ratifies and the upstream detection ticket lands. Until
    // then, the SPA's suppression render branches never fire.
    pathCSuppression: null,
    voucherRecertDays,
    dataIssues: buildDataIssues(enr, engine, degraded),
  };
}

// P1H-01 — extracts the trailing `MM/YYYY` date suffix from a PE Name.
// The SF Name format is `"[PREFIX ]ParticipantName - MM/YYYY"` (e.g.,
// `"GRAD John Stone - 09/2023"`); the SPA wants just the short date for the
// row's PE-meta slot. The participant-name body is PII — extracting only
// the date suffix keeps `peLabel` cache-safe.
//
// Returns `null` when the input is null, empty, or does not end with a
// `MM/YYYY` token (e.g., a future PE naming convention we don't recognize).
function extractPeLabel(peName: string | null): string | null {
  if (peName === null || peName.length === 0) return null;
  const match = /(\d{1,2}\/\d{4})\s*$/.exec(peName);
  return match === null ? null : match[1] ?? null;
}

// P1H-01 — PII strip for the cache write-through path. `CaseloadItem` carries
// `displayName` (Contact name) on the wire response, but the `caseload_cache`
// payload contract (caseload-cache.ts:15-19) and Immutable #1 forbid PII at
// rest. Callers MUST route `body` through this helper before
// `setCaseloadCache({ ..., payload })`. Pure — no I/O, no clock; safe to call
// in any context.
//
// Currently nulls `displayName` only. `peLabel` (date suffix), `programCode`
// (multi-select picklist code), and `aftercareStartDate` (a bare calendar date)
// are not PII. If a future field joins this set, extend here and tighten the
// contract.
export function stripPiiForCache(body: CaseloadBody): CaseloadBody {
  return {
    ...body,
    items: body.items.map((item) => ({ ...item, displayName: null })),
  };
}

// Assembles the E-06 response envelope around a built, filtered, sorted item set.
export function buildCaseloadBody(params: {
  readonly specialistId: string;
  readonly queueId: string;
  readonly queueCounts: Record<string, number>;
  readonly cacheAgeSeconds: number;
  readonly configurationVersion: number;
  readonly items: ReadonlyArray<CaseloadItem>;
}): CaseloadBody {
  return {
    specialistId: params.specialistId,
    queue: params.queueId,
    sort: "priority_desc",
    queueCounts: params.queueCounts,
    cacheAgeSeconds: params.cacheAgeSeconds,
    configurationVersion: params.configurationVersion,
    items: params.items,
  };
}

// Internal shape adapters and per-row builders are exported so the participant-
// detail endpoint (P1F-01, E-08) can reuse them — the §7.4.1 detail response
// MUST emit the same factor / invariant / stabilityVisit / openBarriers / tags
// shape as the caseload row so the SPA can drive a single renderer across the
// queue and the detail page.
export function adaptFactor(factor: FactorContribution): CaseloadFactor {
  return {
    key: factor.key,
    name: factor.name,
    valueLabel: factor.valueLabel,
    valueNumeric: factor.valueNumeric,
    weight: factor.weight,
    pointsContributed: factor.pointsContributed,
  };
}

// P1H-04 — secondary-factor label for the F-02 row's two-line "Why this
// priority" column. Returns the second-highest-impact factor's display name
// after sorting `engine.factors` by `pointsContributed` descending, breaking
// ties by `key` ascending — same comparator `pickHighestImpact` uses for the
// primary (compute.ts). Returns `null` when fewer than two factors carry
// non-zero impact, including the degraded path (`engine === null`).
//
// CAP-AWARENESS DIVERGENCE: sorts on raw `pointsContributed`, while
// `highestImpactFactor` (the primary) is selected from cap-aware effective
// contributions inside the engine (compute.ts `buildEffectiveContributions`).
// When a BR-22 overlap cap fires on a factor pair that includes the
// second-highest, the secondary label can disagree with the post-cap reality
// — the raw runner-up may have been the absorbed member of the cap, so its
// marginal contribution to the score is zero. Phase 0's configuration ships
// a single 2-member cap (TR-PRIORITY-9 / BR-22; see
// `getCalibrationConfiguration` → `factorWeights.overlap_caps`), bounding the
// divergence to that one pair. Ratchet to effective values — which requires
// exposing them from the engine — if a second cap entry lands.
//
// Layered to parallel `primaryFactorLabel`
// (apps/web/app/_components/participant/primary-factor.ts) but kept in the
// API layer to avoid an SPA→API direction violation. Exported (alongside
// `adaptFactor` / `adaptHighestImpact`) so the participant-detail endpoint
// (P1F-01, E-08) reuses it when §7.4.1 lands the same two-line treatment.
// If a third consumer appears, fold both into a shared domain helper per the
// P1F-08 EC-12 parity note in `primary-factor.ts`.
//
// API SPEC GAP: the API spec §7.3.1 does not list this field yet;
// the P1H-04 ticket DOES section flags the spec amendment as a follow-up.
export function deriveSecondaryFactorLabel(
  engine: EngineOutput | null,
): string | null {
  if (engine === null) return null;
  const sorted = [...engine.factors].sort((a, b) => {
    if (b.pointsContributed !== a.pointsContributed) {
      return b.pointsContributed - a.pointsContributed;
    }
    if (a.key < b.key) return -1;
    if (a.key > b.key) return 1;
    return 0;
  });
  const second = sorted[1];
  if (second === undefined || second.pointsContributed <= 0) return null;
  return second.name;
}

export function adaptHighestImpact(
  factor: HighestImpactFactor,
): CaseloadHighestImpactFactor {
  return {
    key: factor.key,
    name: factor.name,
    valueLabel: factor.valueLabel,
    weight: factor.weight,
    pointsContributed: factor.pointsContributed,
  };
}

export function adaptInvariant(
  invariant: TriggeredInvariant,
): CaseloadTriggeredInvariant {
  return {
    invariant_id: invariant.invariantId,
    display_label: invariant.displayLabel,
    // Conditional spread — `triggering_record_id` is absent (not null) for
    // aggregate invariants like BR-24.
    ...(invariant.triggeringRecordId !== undefined && {
      triggering_record_id: invariant.triggeringRecordId,
    }),
  };
}

// BR-19(b) date-only stability state. Mirrors `snapshot-projection.ts`
// `deriveStabilityVisitState` — only `on_track` / `upcoming` are derivable
// from the snapshot.
export function buildStabilityVisit(
  enrollment: EnrollmentSnapshot,
  configuration: Configuration,
  now: Date,
): CaseloadStabilityVisit {
  const upcoming = enrollment.dueDates.upcoming;
  let status: "on_track" | "upcoming" = "on_track";
  if (upcoming !== null) {
    const daysUntil = wholeDaysBetween(now, upcoming);
    if (daysUntil >= 0 && daysUntil <= configuration.dueStatusLeadTimeDays) {
      status = "upcoming";
    }
  }
  return {
    status,
    statusLabel: status === "upcoming" ? "Upcoming" : "On track",
    nextDueDate: upcoming === null ? null : toIsoDate(upcoming),
    checkpoint: null,
    completedCount: enrollment.checkInsCompleted,
    missedCount: enrollment.missedCheckIns,
    scheduledVisitDateTime: null,
  };
}

// F-05 — P1D-04 cycle status for the caseload-row headline badge.
//
// SWAP POINT: `completedStabilityMeetings` is `[]` until per-visit
// Stability Meeting service dates are hydrated. Until then the badge
// reflects pure calendar position (next/missed anchor relative to
// aftercareStartDate) with no BR-25 credit attribution — every active
// participant looks `due` / `overdue` at their next anchor. Replace the
// empty array alone when hydration lands.
export function buildCycleStatus(
  enrollment: EnrollmentSnapshot,
  now: Date,
): CaseloadCycleStatus {
  const output = computeCheckpointState({
    aftercareStartDate: enrollment.aftercareStartDate,
    currentDate: now,
    completedStabilityMeetings: [],
  });
  return {
    state: output.checkpointState,
    daysToNext: output.daysToNext,
    daysOverdue: output.daysOverdue,
    nextCheckpoint: output.nextCheckpoint,
    lastCreditedCheckpoint: output.lastCreditedCheckpoint,
  };
}

// F-05 BR-26 Option A — per-anchor breakdown for the F-07 detail page (P1F-07).
//
// SWAP POINT: same `completedStabilityMeetings: []` substrate as
// `buildCycleStatus` above. Until per-visit Stability Meeting service dates
// are hydrated, every passed anchor surfaces as `overdue` (the freshest miss)
// or `catch_up` (older misses) — `complete` is unreachable. The breakdown is
// still useful for calendar-position display (which anchors have passed, which
// are coming up); see ticket P1F-07 §Open GAP flags.
export function buildPerCheckpointBreakdown(
  enrollment: EnrollmentSnapshot,
  now: Date,
): ReadonlyArray<PerCheckpointBreakdownDto> {
  return computePerCheckpointStates({
    aftercareStartDate: enrollment.aftercareStartDate,
    currentDate: now,
    completedStabilityMeetings: [],
  }).map((row) => ({ anchor: row.anchor, state: row.state }));
}

// BR-19(e) — open Barriers identified at the Aftercare stage. "Open" is
// `endDate === null`; severity resolves from `barrierSeverityClassification`
// keyed on type (the Demo seed is `{}`, so severity is `null` until tuned).
export function buildOpenBarriers(
  barriers: ReadonlyArray<BarrierSnapshot>,
  configuration: Configuration,
  now: Date,
): ReadonlyArray<CaseloadOpenBarrier> {
  return barriers
    .filter(
      (barrier) => barrier.endDate === null && barrier.stage === "Aftercare",
    )
    .map((barrier) => ({
      barrierId: barrier.id,
      type: barrier.type,
      severity:
        barrier.type === null
          ? null
          : (configuration.barrierSeverityClassification[barrier.type] ?? null),
      openedAt: barrier.startDate === null ? null : barrier.startDate.toISOString(),
      ageDays:
        barrier.startDate === null
          ? null
          : wholeDaysBetween(barrier.startDate, now),
    }));
}

// P1H-03 — marshalling helper that adapts the structured CaseloadSnapshot +
// active Configuration into the flat `RowTagSnapshot` the domain function
// reads. Exported so the participant-detail page (P1F-01, E-08) builds the
// same chip cluster as the caseload row from one source of truth.
//
// `failedAttempts` reuses the BR-19(c) projection: the SF DLRS rollup
// `Num_of_Aftercare_Check_Ins_Attempted__c` (lifetime count, KNOWN LIMITATION
// documented in `snapshot-projection.ts` `deriveFailedAttempts`). `null` rolls
// up to `0` so the threshold check never fires on missing data.
//
// `arrearsCount` is pre-counted here — the domain function never receives the
// raw arrear shape (which carries PII-adjacent free-text fields).
export interface BuildRowTagSnapshotInput {
  readonly enrollment: EnrollmentSnapshot;
  readonly snapshot: CaseloadSnapshot;
  readonly perCheckpointBreakdown: ReadonlyArray<PerCheckpointBreakdownDto>;
  readonly voucherRecertDays: number | null;
  readonly configuration: Configuration;
}

export function buildRowTagSnapshot(
  input: BuildRowTagSnapshotInput,
): RowTagSnapshot {
  const { enrollment, snapshot, perCheckpointBreakdown, configuration } = input;
  const failedAttempts =
    typeof enrollment.checkInsAttempted === "number" &&
    Number.isFinite(enrollment.checkInsAttempted)
      ? enrollment.checkInsAttempted
      : 0;
  return {
    upcomingVisitDueDate: enrollment.dueDates.upcoming,
    failedAttempts,
    failedAttemptsThreshold:
      configuration.tierInvariants.failed_attempts_tier1_threshold,
    voucherRecertDays: input.voucherRecertDays,
    voucherRecertWarningDays: configuration.voucherRecertWarningDays,
    perCheckpointBreakdown,
    incidents: snapshot.incidents.map((incident) => ({
      incidentDate: incident.incidentDate,
    })),
    arrearsCount: snapshot.arrears.length,
    aftercareExtensionEndDate: enrollment.aftercareExtensionEndDate,
    // P1H-10 stub: always null. The DTO `pathCSuppression` field on the
    // CaseloadItem is likewise always null today; when ratified, the same
    // projection feeds both `RowTagSnapshot` (for tag emission) and the
    // wire shape (for the SPA's row treatment).
    pathCSuppression: null,
  };
}

// Graceful-degradation signals (FS-06, EC-08, TR-SF-12). Empty on healthy rows.
export function buildDataIssues(
  enrollment: EnrollmentSnapshot,
  engine: EngineOutput | null,
  degraded: boolean,
): ReadonlyArray<string> {
  const issues: string[] = [];
  if (enrollment.aftercareStartDate === null) {
    issues.push("missing_aftercare_start_date");
  }
  if (degraded) issues.push("degraded_score");
  if (
    engine !== null &&
    engine.factors.some((factor) => factor.dataQualityWarning !== undefined)
  ) {
    issues.push("stale_factor_data");
  }
  return issues;
}
