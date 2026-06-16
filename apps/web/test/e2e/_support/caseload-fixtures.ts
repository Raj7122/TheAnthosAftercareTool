// Synthetic 75-participant caseload fixture for the P1C-07 perf E2E.
//
// Two outputs from the same generator:
//
//   1. `buildWarmCaseloadBodies` — pre-shaped `CaseloadBody` payloads for all
//      four queues, written straight to `caseload_cache`. The warm-path test
//      navigates to `/caseload`, the Server Component hits the cache, and the
//      payload comes back without ever touching SF or the engine. This is
//      what makes the ≤2s AC-05 assertion possible against a 75-participant
//      caseload — the cache is opaque jsonb at the persistence layer, so the
//      fixture is shape-checked by the `CaseloadBody` type alone.
//
//   2. `buildSoqlFixture` — SOQL response shapes for the cold-path test. The
//      mock SF server returns these on the IDW_Program_Enrollment__c parent
//      query (round-trip 1) and on each of the four composite-batch siblings
//      (round-trip 2 — Barriers, Incident_Participant, Arrear, Repair). The
//      cold path then runs `scoreCaseload → hydrateCaseload → engine`, which
//      writes through to the cache; the test asserts the ≤5s envelope on that
//      hydration + scoring round-trip end-to-end.
//
// Both outputs share `generateSyntheticCaseload` so the participant Id space
// is consistent — i.e. the cold-path write-through hands the cache a body
// keyed on the same 18-char enrollment Ids the warm-path seeded payload uses.
// All Ids pass `assertSalesforceId` (15- or 18-char alphanumeric); no PII
// (Immutable #1 — no names, no contacts).
//
// Date arithmetic: every fixture uses `now` (the test clock — injectable so
// CI runs on different calendar days are deterministic). The warm-path
// participant baseline is "successful contact 60 days ago, next check-in
// 14 days out" — that lands all 75 in `caseload_overview` (VR-08), `due_soon`
// (next check-in 14 days out is >0 and ≤30 days out), and
// `check_ins_due_this_month` (60 ≥ 28 days since contact). It deliberately
// misses `never_successfully_contacted` (a successful contact exists), so
// that queue is the empty-state target.

import { MOCK_SF_ORIGIN, SPECIALIST_ID } from "./constants.js";

// The four BR-22 queues per FS v1.12 §F-04 and `calibration-config.ts`. The
// fixture hardcodes these instead of importing the M-CONFIG default so a
// future config tuning doesn't silently change what this test asserts.
export const QUEUE_IDS = [
  "caseload_overview",
  "due_soon",
  "never_successfully_contacted",
  "check_ins_due_this_month",
] as const;
export type QueueId = (typeof QUEUE_IDS)[number];

// `configVersion` the cache rows are keyed by. The runtime stub's
// `configuration.version` is 0, which `get-caseload.ts` floors to 1 (the
// `caseload_cache.config_version > 0` CHECK constraint). Match it here so the
// seeded rows align with what the BFF reads.
export const FIXTURE_CONFIG_VERSION = 1;

// One synthetic caseload participant — the Ids referenced by both the warm
// cache payload and the cold-path SOQL response.
export interface SyntheticParticipant {
  readonly enrollmentId: string;   // IDW_Program_Enrollment__c.Id
  readonly contactId: string;      // Contact__c (also used by Incident_Participant)
  readonly accountId: string;      // Account__c
  // Pre-derived score + tier so the warm payload is deterministic. Cold path
  // computes its own (engine output is opaque to the fixture).
  readonly tier: 1 | 2 | 3;
  readonly priorityScore: number;
}

export interface CaseloadFixture {
  readonly participants: ReadonlyArray<SyntheticParticipant>;
  readonly now: Date;
}

// 18-char alphanumeric ids that pass `assertSalesforceId`. The fixed `Q` /
// `K` / `A` segments mirror SF's checksum-byte slots so the shape reads as
// real, but no real Ids are reproduced. `i` is 1-padded to 3 digits → unique
// within a 75-participant run (the test will never need >999).
function syntheticEnrollmentId(i: number): string {
  return `a0X8K00000${String(i).padStart(5, "0")}QAA`;
}

function syntheticContactId(i: number): string {
  return `0038K00000${String(i).padStart(5, "0")}AAA`;
}

function syntheticAccountId(i: number): string {
  return `0018K00000${String(i).padStart(5, "0")}AAA`;
}

function syntheticBarrierId(i: number): string {
  return `a008K00000${String(i).padStart(5, "0")}QAA`;
}

// Generates the synthetic caseload. `count` defaults to 75 — the spec'd AC-05
// envelope and the only size this test exists to validate.
export function generateSyntheticCaseload(
  options: { readonly count?: number; readonly now?: Date } = {},
): CaseloadFixture {
  const count = options.count ?? 75;
  const now = options.now ?? new Date();
  const participants: SyntheticParticipant[] = [];
  for (let i = 1; i <= count; i += 1) {
    // Round-robin tier distribution so the warm payload exercises all three
    // tier badges in the SPA. Scores descend monotonically inside each tier
    // bucket so within-queue ordering (BR-21, priority-desc) is stable.
    const tier = ((i % 3) + 1) as 1 | 2 | 3;
    const priorityScore = 100 - i * 0.5; // 99.5 → 62.5 across 75 rows.
    participants.push({
      enrollmentId: syntheticEnrollmentId(i),
      contactId: syntheticContactId(i),
      accountId: syntheticAccountId(i),
      tier,
      priorityScore,
    });
  }
  return { participants, now };
}

// --- Warm-path cache payload --------------------------------------------------

// CaseloadBody / CaseloadItem are re-defined here as plain JSON shapes to
// avoid importing `@anthos/api` into the test fixture (the cache is opaque
// jsonb at the DB layer — shape-matching to the `CaseloadBody` TS type is
// what `get-caseload.ts` consumes). Keeping the surface narrow means a future
// DTO addition is a one-file delta here.
interface FixtureFactor {
  readonly name: string;
  readonly valueLabel: string;
  readonly valueNumeric: number;
  readonly weight: string;
  readonly pointsContributed: number;
}

interface FixtureCaseloadItem {
  readonly participantId: string;
  // P1H-01 — F-02 row display fields. `displayName` is PII; the fixture
  // ships a synthetic non-PII string so the warm-cache rendered row has the
  // same shape as a production row (the cache write-path strips PII to null
  // via `stripPiiForCache`, but the warm payload these tests seed pre-dates
  // that strip — both `null` and a synthetic string are acceptable shapes
  // for the row component).
  readonly displayName: string | null;
  readonly peLabel: string | null;
  readonly programCode: string | null;
  readonly aftercareDay: number | null;
  readonly aftercareStartDate: string | null;
  readonly tier: 1 | 2 | 3;
  readonly tierLabel: string;
  readonly priorityScore: number;
  readonly priorityModifier: string | null;
  readonly highestImpactFactor: {
    readonly name: string;
    readonly valueLabel: string;
    readonly weight: string;
    readonly pointsContributed: number;
  };
  readonly factors: ReadonlyArray<FixtureFactor>;
  // P1H-04 — second-highest-impact factor name; null when fewer than two
  // factors carry non-zero impact.
  readonly secondaryFactorLabel: string | null;
  readonly triggered_invariants: ReadonlyArray<never>;
  readonly lastSuccessfulContactDaysAgo: number | null;
  readonly stabilityVisit: {
    readonly status: "on_track" | "upcoming";
    readonly statusLabel: string;
    readonly nextDueDate: string | null;
    readonly checkpoint: null;
    readonly completedCount: number | null;
    readonly missedCount: number | null;
    readonly scheduledVisitDateTime: null;
  };
  // P1D-04 — F-05 cycle status; required by `CycleBadge` on every row.
  readonly cycleStatus: {
    readonly state:
      | "not_in_cycle"
      | "pre_enrollment"
      | "future"
      | "complete"
      | "due"
      | "overdue"
      | "catch_up"
      | "between"
      | "cycle_complete";
    readonly daysToNext: number | null;
    readonly daysOverdue: number;
    readonly nextCheckpoint: 90 | 180 | 270 | 365 | null;
    readonly lastCreditedCheckpoint: 90 | 180 | 270 | 365 | null;
  };
  // P1H-02 — per-anchor cycle breakdown (F-05 BR-26 Option A). One entry
  // per `CHECKPOINT_ANCHORS` value in ascending order.
  readonly perCheckpointBreakdown: ReadonlyArray<{
    readonly anchor: 90 | 180 | 270 | 365;
    readonly state: "future" | "complete" | "due" | "overdue" | "catch_up";
  }>;
  readonly openBarriers: ReadonlyArray<never>;
  // P1H-14 — Aftercare Extended program-modifier flag. When true, the SPA
  // renders `<ProgramModifierChip />` inline with displayName. Optional in
  // the wire fixture so the warm-cache jsonb stays narrow; the SPA's
  // `item.aftercareExtended && <chip/>` is defensive against undefined.
  readonly aftercareExtended?: boolean;
  // P1H-03 — severity-coded chips for the row's "Barriers / Tags" column.
  // The fixture emits one upcoming-visit chip (synthetic data has the next
  // visit due "today", which the derivation surfaces as `visit_overdue` once
  // the wall clock crosses noon — the value here is purely shape-conformance,
  // no SPA assertion reads it).
  readonly tags: ReadonlyArray<{
    readonly key: string;
    readonly label: string;
    readonly severity: "high" | "med" | "low" | "info";
  }>;
  readonly voucherRecertDays: number | null;
  readonly dataIssues: ReadonlyArray<never>;
}

export interface FixtureCaseloadBody {
  readonly specialistId: string;
  readonly queue: QueueId;
  readonly sort: "priority_desc";
  readonly queueCounts: Record<QueueId, number>;
  readonly cacheAgeSeconds: number;
  readonly configurationVersion: number;
  readonly items: ReadonlyArray<FixtureCaseloadItem>;
}

// Per-participant CaseloadItem. Two synthetic factors are included so the
// row's expandable breakdown panel has content; the highest-impact factor
// mirrors the first one.
function buildItem(
  participant: SyntheticParticipant,
  now: Date,
): FixtureCaseloadItem {
  const factors: FixtureFactor[] = [
    {
      name: "Failed attempts",
      valueLabel: "2",
      valueNumeric: 2,
      weight: "0.30",
      pointsContributed: 18,
    },
    {
      name: "Days since last successful contact",
      valueLabel: "60",
      valueNumeric: 60,
      weight: "0.20",
      pointsContributed: 12,
    },
  ];
  const tierLabel = participant.tier === 1 ? "Tier 1" : participant.tier === 2 ? "Tier 2" : "Tier 3";
  // Next-check-in date is "today" — keeps the warm payload's `nextDueDate`
  // self-consistent with the cold-path SOQL fixture below.
  const nextDueIso = `${now.toISOString().slice(0, 10)}`;
  // 120 days before "now" — matches the synthetic `aftercareDay: 120` below and
  // is the anchor the caseload activity calendar plots checkpoints from.
  const aftercareStartIso = new Date(now.getTime() - 120 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  return {
    participantId: participant.enrollmentId,
    // P1H-01 — `null` matches the cache-strip contract (`stripPiiForCache`
    // zeroes `displayName` before persistence). `peLabel` / `programCode`
    // are cache-safe but the synthetic fixture has no Salesforce metadata
    // to derive them from; the row component falls back to monospace ID
    // when displayName is null and renders the peMeta line only when at
    // least one of the parts is non-empty.
    displayName: null,
    peLabel: null,
    programCode: null,
    aftercareDay: 120,
    aftercareStartDate: aftercareStartIso,
    tier: participant.tier,
    tierLabel,
    priorityScore: participant.priorityScore,
    priorityModifier: null,
    highestImpactFactor: {
      name: factors[0]!.name,
      valueLabel: factors[0]!.valueLabel,
      weight: factors[0]!.weight,
      pointsContributed: factors[0]!.pointsContributed,
    },
    factors,
    // P1H-04 — the synthetic engine emits 2 factors; the second one
    // becomes the secondary-line label after the impact-desc sort.
    secondaryFactorLabel: factors[1]!.name,
    triggered_invariants: [],
    lastSuccessfulContactDaysAgo: 60,
    stabilityVisit: {
      status: "upcoming",
      statusLabel: "Upcoming",
      nextDueDate: nextDueIso,
      checkpoint: null,
      completedCount: 3,
      missedCount: 0,
      scheduledVisitDateTime: null,
    },
    // 120 days post-aftercare-start with no Stability Meeting credits (empty
    // visits per P1D-04 scope-down): the 90-day checkpoint is 30 days past
    // and uncredited, the 180-day is 60 days out (outside the BR-28 due
    // window). BR-29 → `overdue`. Matches the synthetic `aftercareDay: 120`.
    cycleStatus: {
      state: "overdue",
      daysToNext: 60,
      daysOverdue: 30,
      nextCheckpoint: 180,
      lastCreditedCheckpoint: null,
    },
    // P1H-02 — matches the `cycleStatus.state="overdue"` aggregate above:
    // 90-day anchor passed and uncredited, others future.
    perCheckpointBreakdown: [
      { anchor: 90, state: "overdue" },
      { anchor: 180, state: "future" },
      { anchor: 270, state: "future" },
      { anchor: 365, state: "future" },
    ],
    openBarriers: [],
    tags: [],
    // P1H-14 — every 5th synthetic participant is flagged Aftercare Extended
    // (15 of 75 rows). Visual-smoke target: load /caseload and confirm a
    // green "Extended" pill renders inline with displayName for those rows
    // and is absent on the other 60.
    aftercareExtended: extractSyntheticIndex(participant.enrollmentId) % 5 === 0,
    voucherRecertDays: 180,
    dataIssues: [],
  };
}

// Recovers the 1-based index from a syntheticEnrollmentId — the segment
// between the leading `a0X8K00000` prefix and the trailing `QAA` checksum.
// Returns 0 on parse failure so the modulo-based seed flag stays defensive
// against any future Id shape change.
function extractSyntheticIndex(id: string): number {
  const match = /a0X8K00000(\d{5})QAA$/.exec(id);
  return match === null ? 0 : Number(match[1]);
}

// Builds the four `CaseloadBody` payloads for the warm cache. Every queue
// EXCEPT `never_successfully_contacted` carries all 75 rows (see file-header
// note on predicate-by-predicate qualification); that queue is empty by
// design so the E2E asserts the VR-09 empty-state path.
export function buildWarmCaseloadBodies(
  fixture: CaseloadFixture,
  specialistId: string = SPECIALIST_ID,
): Record<QueueId, FixtureCaseloadBody> {
  const allItems = fixture.participants.map((p) => buildItem(p, fixture.now));
  const queueCounts: Record<QueueId, number> = {
    caseload_overview: allItems.length,
    due_soon: allItems.length,
    never_successfully_contacted: 0,
    check_ins_due_this_month: allItems.length,
  };
  const bodyFor = (queueId: QueueId, items: ReadonlyArray<FixtureCaseloadItem>): FixtureCaseloadBody => ({
    specialistId,
    queue: queueId,
    sort: "priority_desc",
    queueCounts,
    cacheAgeSeconds: 0,
    configurationVersion: FIXTURE_CONFIG_VERSION,
    items,
  });
  return {
    caseload_overview: bodyFor("caseload_overview", allItems),
    due_soon: bodyFor("due_soon", allItems),
    never_successfully_contacted: bodyFor("never_successfully_contacted", []),
    check_ins_due_this_month: bodyFor("check_ins_due_this_month", allItems),
  };
}

// --- Cold-path SOQL fixture ---------------------------------------------------
//
// Five SOQL response shapes that, fed through `hydrateCaseload`, produce 75
// `CaseloadSnapshot`s the engine can score. Field names mirror
// `packages/integrations/src/salesforce/bulk-hydration.ts` exactly — they are
// the SF API names, not the snapshot's camelCase. The mock SF server pattern-
// matches the SOQL `FROM <object>` substring to discriminate; the records are
// returned wrapped in `{ totalSize, done, records }` (or as a composite-batch
// sub-result) by the server itself.

export interface EnrollmentSoqlRecord {
  readonly Id: string;
  // P1H-01 — F-02 row display plumbing. `Name` and `Client_Type__c` are
  // PII-free; `Contact__r.Name` IS PII (the cold-path write-through nulls it
  // via `stripPiiForCache` before persisting). Without these the DTO's
  // `extractPeLabel(enr.peName)` reads `.length` on `undefined` → 500.
  readonly Name: string;
  readonly Client_Type__c: string | null;
  readonly Contact__r: { readonly Name: string | null } | null;
  readonly Aftercare_Owner__c: string;
  readonly Most_Recent_Successful_Contact__c: string;
  readonly Aftercare_Start_Date__c: string;
  readonly Aftercare_End_Date__c: string;
  readonly Aftercare_Extension_End_Date__c: null;
  readonly Aftercare_First_Due_Date__c: null;
  readonly Aftercare_Second_Due_Date__c: null;
  readonly Aftercare_Third_Due_Date__c: null;
  readonly Aftercare_Fourth_Due_Date__c: null;
  readonly Upcoming_Aftercare_Visit_Due_Date__c: string;
  readonly Program_Enrollment_Outcome__c: null;
  readonly Contact__c: string;
  readonly Account__c: string;
  readonly Subsidy_Renewal_Re_Cert_Due_Date__c: string;
  readonly Num_of_Aftercare_Check_Ins_Attempted__c: number;
  readonly Number_of_Aftercare_Check_Ins_Completed__c: number;
  readonly Number_of_Missed_Check_Ins__c: number;
}

export interface BarrierSoqlRecord {
  readonly Id: string;
  readonly Program_Enrollment__c: string;
  readonly Type__c: string | null;
  readonly Status__c: string | null;
  readonly Stage__c: string;
  readonly Start_Date__c: string | null;
  readonly End_Date__c: null;
}

export interface IncidentParticipantSoqlRecord {
  readonly Id: string;
  readonly Contact__c: string;
  readonly Incident__c: string;
  readonly Role__c: string | null;
  readonly Incident__r: {
    readonly Incident_Type__c: string | null;
    readonly Status__c: string | null;
    readonly Critical_Incident__c: boolean | null;
    readonly Incident_Start_Date_Time__c: string | null;
  } | null;
}

export interface ArrearSoqlRecord {
  readonly Id: string;
  readonly Program_Enrollment__c: string;
  readonly Unit_Engagement__c: null;
  readonly Status__c: string | null;
  readonly Date_Identified__c: string | null;
  readonly Date_Resolved__c: null;
  readonly Arrears_Start_Date__c: string | null;
  readonly Arrears_End_Date__c: null;
  readonly Arrears_Purpose__c: null;
  readonly Estimated_Amount__c: null;
  readonly Amount_Paid__c: null;
  readonly Length_of_Time_Months_Formula__c: null;
}

export interface RepairSoqlRecord {
  readonly Id: string;
  readonly Status__c: string | null;
  readonly Pre_or_Post_Move_In__c: string | null;
  readonly Completed_Date__c: null;
  readonly Due_Date__c: string | null;
  readonly Identification_Date__c: string | null;
  readonly Urgency__c: string | null;
  readonly of_Days_Overdue__c: number | null;
  readonly Unit_Rental__r: { readonly Program_Enrollment__c: string } | null;
}

export interface SoqlFixture {
  readonly enrollments: ReadonlyArray<EnrollmentSoqlRecord>;
  readonly barriers: ReadonlyArray<BarrierSoqlRecord>;
  readonly incidents: ReadonlyArray<IncidentParticipantSoqlRecord>;
  readonly arrears: ReadonlyArray<ArrearSoqlRecord>;
  readonly repairs: ReadonlyArray<RepairSoqlRecord>;
}

// Day-arithmetic — UTC-anchored so the predicate evaluator's UTC-month check
// is satisfied deterministically regardless of CI timezone.
function isoDateUtc(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDaysUtc(d: Date, days: number): Date {
  const out = new Date(d);
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}

// Builds the SOQL fixture for the cold path. Each participant has:
//   - One enrollment record owned by `SPECIALIST_ID`, last successful contact
//     60 days ago (>= 28 → qualifies for `check_ins_due_this_month`), next
//     check-in 14 days out (>0 and ≤30 days out → qualifies for `due_soon`,
//     the default landing queue), contacted at least once → does NOT qualify
//     for `never_successfully_contacted`. Final distribution mirrors the warm
//     fixture's `queueCounts`.
//   - Empty siblings by default (no barriers / incidents / arrears / repairs)
//     — keeps the engine pass minimal and the assertion focused on the
//     scaffolded path, not on factor specifics. The fixture exposes the
//     barrier array as a non-frozen field so the CDC stale-fresh test can
//     mutate it between cold passes.
export function buildSoqlFixture(fixture: CaseloadFixture): SoqlFixture {
  const now = fixture.now;
  const contactDate = addDaysUtc(now, -60);
  const startDate = addDaysUtc(now, -120);
  const endDate = addDaysUtc(now, 240);
  const recertDate = addDaysUtc(now, 180);
  // Next check-in 14 days out (the config's `dueStatusLeadTimeDays`). Must be
  // strictly in the FUTURE relative to the scoring instant `now`: a same-day
  // (midnight) date lands a hair BEHIND `now`, yielding a negative
  // `daysUntilNextCheckIn` that the `due_soon` predicate excludes via its
  // `>= 0` past-due guard (EC-13) — which would empty the default landing
  // queue on the cold path. 14 days is safely within the 30-day window.
  const upcomingCheckInDate = addDaysUtc(now, 14);
  const enrollments: EnrollmentSoqlRecord[] = fixture.participants.map((p, i) => ({
    Id: p.enrollmentId,
    // P1H-01 — synthetic PE Name in the canonical "PREFIX Body - MM/YYYY"
    // shape so `extractPeLabel` resolves a non-null suffix; `Client_Type__c`
    // alternates so multi-value rendering has a non-trivial sample. The
    // `Contact__r.Name` value is synthetic — no real PII.
    Name: `SYN P${String(i + 1).padStart(3, "0")} - 09/2023`,
    Client_Type__c: i % 2 === 0 ? "ACS" : "ACS;HHN",
    Contact__r: { Name: `Synthetic Contact ${i + 1}` },
    Aftercare_Owner__c: SPECIALIST_ID,
    Most_Recent_Successful_Contact__c: isoDateUtc(contactDate),
    Aftercare_Start_Date__c: isoDateUtc(startDate),
    Aftercare_End_Date__c: isoDateUtc(endDate),
    Aftercare_Extension_End_Date__c: null,
    Aftercare_First_Due_Date__c: null,
    Aftercare_Second_Due_Date__c: null,
    Aftercare_Third_Due_Date__c: null,
    Aftercare_Fourth_Due_Date__c: null,
    Upcoming_Aftercare_Visit_Due_Date__c: isoDateUtc(upcomingCheckInDate),
    Program_Enrollment_Outcome__c: null,
    Contact__c: p.contactId,
    Account__c: p.accountId,
    Subsidy_Renewal_Re_Cert_Due_Date__c: isoDateUtc(recertDate),
    Num_of_Aftercare_Check_Ins_Attempted__c: 3,
    Number_of_Aftercare_Check_Ins_Completed__c: 2,
    Number_of_Missed_Check_Ins__c: 0,
  }));
  return {
    enrollments,
    barriers: [],
    incidents: [],
    arrears: [],
    repairs: [],
  };
}

// Installs (replaces) the in-memory caseload SOQL fixture on the mock SF
// server. The mock SF process is shared across the playwright run via the
// webServer in playwright.config.ts, so this MUST be called before each
// cold-path test to reset state from any prior pass — defensive even when
// the test only cares about a single cold pass.
export async function installSfFixture(soql: SoqlFixture): Promise<void> {
  const response = await fetch(`${MOCK_SF_ORIGIN}/test/install-fixture`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(soql),
  });
  if (!response.ok) {
    throw new Error(
      `mock SF rejected fixture install: ${response.status} ${response.statusText}`,
    );
  }
}

// CDC stale-fresh helper. Adds one open barrier to the fixture so the next
// cold hydrate yields a different snapshot — the test reads the new
// barrier count out of `queueCounts` or row tags as evidence that the
// invalidation + rehydrate composed correctly. Returns the index-1 barrier
// for assertion.
export function addBarrierToFixture(
  soql: SoqlFixture,
  participantIndex: number,
): { readonly barrier: BarrierSoqlRecord; readonly updated: SoqlFixture } {
  const enr = soql.enrollments[participantIndex];
  if (enr === undefined) {
    throw new Error(`participantIndex ${participantIndex} out of range`);
  }
  const barrier: BarrierSoqlRecord = {
    Id: syntheticBarrierId(participantIndex + 1),
    Program_Enrollment__c: enr.Id,
    Type__c: "Housing",
    Status__c: "Open",
    Stage__c: "Aftercare",
    Start_Date__c: isoDateUtc(addDaysUtc(new Date(enr.Aftercare_Start_Date__c), 7)),
    End_Date__c: null,
  };
  return {
    barrier,
    updated: {
      ...soql,
      barriers: [...soql.barriers, barrier],
    },
  };
}
