// P0-08: Typed snapshot returned by the Salesforce bulk-hydration adapter.
//
// The adapter is the SOLE layer that touches Salesforce (Salesforce is the
// system of record). Engine, calibration UI, and BFF consume these structurally-typed
// snapshots — never raw SOQL responses.
//
// Field selection derives from FS v1.12 §F-03 BR-19 (a)–(i) data sources and
// the live `anthos-demo` schema verified against `IDW_Program_Enrollment__c`,
// `Barriers__c`, the `Incident_Participant__c` → `Incident__c` junction
// (P0-08d schema introspection),
// `Arrear__c` (P0-08b), and
// `Repair__c` (P0-04e).
// P0-04 will define the mapping `CaseloadSnapshot → HydratedParticipant` per
// factor; that is intentionally out of scope here.

export interface CaseloadSnapshot {
  readonly participantId: string;
  // The aftercare specialist this caseload row belongs to — the
  // `Aftercare_Owner__c` the round-1 query filtered on (P0-08d / FS v1.12
  // §F-03 "the assigned Aftercare Specialist").
  readonly ownerId: string;
  readonly hydratedAt: Date;
  readonly enrollment: EnrollmentSnapshot;
  readonly barriers: ReadonlyArray<BarrierSnapshot>;
  readonly incidents: ReadonlyArray<IncidentSnapshot>;
  // BR-19(g) arrears signal — every `Arrear__c` row for the PE, carried
  // unfiltered (P0-08b). The BR-19(g) factor swap (Barriers → arrears) is the
  // separate P0-08c ticket.
  readonly arrears: ReadonlyArray<ArrearSnapshot>;
  // BR-25 open-repair invariant signal — every `Repair__c` row joined to the
  // PE via the two-hop `Unit_Rental__r.Program_Enrollment__c` path, carried
  // unfiltered (P0-04e). The open-status + Pre/Post-Move-In trigger logic is
  // the engine's job (`createOpenRepairInvariant`).
  readonly repairs: ReadonlyArray<RepairSnapshot>;
}

// Mirror of IDW_Program_Enrollment__c with engine-relevant fields only.
// `voucherRecertDeadline` is sourced from the SF-side formula
// `Subsidy_Renewal_Re_Cert_Due_Date__c` (GAP-17 closed 2026-05-19).
// `unitEngagement` remains a
// Q15 stub — the schema half is now resolved (the canonical object is
// `Unit_Rental__c`, label "Unit Engagement", 334 fields; MCP-confirmed
// 2026-05-19); only the
// BR-19 factor field/combination needs Erick's semantic sign-off. P0-08a
// tracks it.
export interface EnrollmentSnapshot {
  readonly aftercareOwnerId: string | null;
  // P1H-01 — F-02 row redesign display plumbing. Three fields the row needs:
  //  - `peName`: raw `IDW_Program_Enrollment__c.Name`, format
  //    `"[PREFIX ]ParticipantName - MM/YYYY"`. The DTO layer extracts the
  //    `MM/YYYY` suffix as `CaseloadItem.peLabel`.
  //  - `displayName`: raw `Contact__r.Name`. **PII** — never persisted to
  //    Postgres (`caseload_cache`), never logged, never placed in URLs or
  //    `audit_log.payload_metadata`. The DTO layer carries it on the wire
  //    response; `stripPiiForCache` (in dto.ts) nulls it before the cache
  //    write. Warm-cache reads return `displayName: null`.
  //  - `programCode`: raw `Client_Type__c` (Multi-Select Picklist). Sample
  //    values `"ACS"`, `"HHN"`, or `"ACS;HHN"` for multi-value. SPA owns
  //    rendering decisions.
  // Source verification: SF MCP probe on `anthos-demo` 2026-05-25.
  readonly peName: string | null;
  readonly displayName: string | null;
  readonly programCode: string | null;
  // SF Formula (Date) on IDW_Program_Enrollment__c, API name
  // `Most_Recent_Successful_Contact__c`:
  //   IF(Contact__r.Most_Recent_Email__c > Contact__r.Most_Recent_Successful_Case_Note__c,
  //      Contact__r.Most_Recent_Email__c,
  //      Contact__r.Most_Recent_Successful_Case_Note__c)
  // Semantics: MAX(most recent email, most recent successful case note),
  // both stored on the related Contact — i.e. "latest successful contact",
  // NOT "latest attempted contact". Population 112/624 = 17.9% in the
  // sandbox at 2026-05-19. GAP-5 field-side resolved via SF MCP
  // introspection in P0-09; Path A/B/C ratification still leadership-owned
  // (tracked via GAP-9 / BR-21).
  readonly mostRecentSuccessfulContact: Date | null;
  readonly aftercareStartDate: Date | null;
  readonly aftercareEndDate: Date | null;
  readonly aftercareExtensionEndDate: Date | null;
  readonly aftercareExtended: boolean;
  readonly dueDates: AftercareDueDates;
  readonly programEnrollmentOutcome: string | null;
  readonly contactId: string | null;
  readonly accountId: string | null;
  readonly voucherRecertDeadline: Date | null;
  // BR-19(c) `failed_attempts` candidate source — raw PE check-in rollup
  // counts. The adapter carries these through; how the engine derives the
  // factor is an open P0-04 decision (schema memo BR-19 row (c) flags it
  // "decision needed"). The dropped `IDW_Case_Note__c` query is not an
  // alternative — that object has no participant link (P0-08d).
  readonly checkInsAttempted: number | null;
  readonly checkInsCompleted: number | null;
  readonly missedCheckIns: number | null;
  readonly unitEngagement?: unknown;
}

export interface AftercareDueDates {
  readonly first: Date | null;
  readonly second: Date | null;
  readonly third: Date | null;
  readonly fourth: Date | null;
  readonly upcoming: Date | null;
}

// Barriers__c — Status__c is a formula (Open while End_Date__c is null).
// Stage__c carries the BR-19(f) "Stage That Barrier was Identified" picklist;
// engine filters to Stage = 'Aftercare' at factor compute time.
// `daysSinceLastUpdate` mirrors the Salesforce formula
// `Days_Since_Last_Update__c` = `TODAY() - Last_Updated__c` (Formula (Number),
// BlankAsZero) — MCP-confirmed against anthos-demo 2026-05-23. Engine consumes
// it for BR-39 staleness multiplier (FS §723, TRD TR-BAR-3).
export interface BarrierSnapshot {
  readonly id: string;
  readonly type: string | null;
  readonly status: string | null;
  readonly stage: string | null;
  readonly startDate: Date | null;
  readonly endDate: Date | null;
  readonly daysSinceLastUpdate: number | null;
}

// Arrear__c — the canonical Arrears object (BR-19(g) data source). API name
// is singular `Arrear__c`; Object Manager label is "Arrears" (plural).
// MCP-confirmed: direct
// Lookup FK `Program_Enrollment__c` to the PE; `unitEngagementId` is the
// `Unit_Engagement__c` lookup to `Unit_Rental__c`; `lengthOfTimeMonths` is
// the SF formula-number `Length_of_Time_Months_Formula__c`. The sandbox held
// 0 `Arrear__c` rows at 2026-05-19. `status` carries the restricted
// `Status__c` picklist (Identified | Under Review | Approved | Resolved With
// Anthos Payment | Resolved Without Anthos Payment) — its open/closed
// semantics are still pending Erick (P0-09b). PII fields (`Notes__c`,
// `Submitter__c`, `Submitter_Email__c`, `Description_FormAssembly__c`,
// `Household_Share__c`) are intentionally NOT hydrated. The adapter carries
// every arrear row unfiltered; BR-19(g) status/recency factor logic is the
// engine's job (P0-08c).
export interface ArrearSnapshot {
  readonly id: string;
  readonly programEnrollmentId: string | null;
  readonly unitEngagementId: string | null;
  readonly status: string | null;
  readonly dateIdentified: Date | null;
  readonly dateResolved: Date | null;
  readonly arrearsStartDate: Date | null;
  readonly arrearsEndDate: Date | null;
  readonly purpose: string | null;
  readonly estimatedAmount: number | null;
  readonly amountPaid: number | null;
  readonly lengthOfTimeMonths: number | null;
}

// Repair__c — the canonical Repairs object and the BR-25 invariant data source
// (P0-04e; Julia rerouted BR-25 off the Barriers picklist 2026-05-19). There is
// NO direct PE FK — the participant join is two hops:
// `Repair__c.Unit_Rental__r.Program_Enrollment__c → IDW_Program_Enrollment__c`,
// so `programEnrollmentId` is read through the `Unit_Rental__r` parent
// relationship. `status` carries the `Status__c` picklist (5 non-terminal +
// `Completed` / `Canceled`); `preOrPostMoveIn` carries the
// `Pre_or_Post_Move_In__c` formula (`"Pre Move-In"` | `"Post Move-In"`).
// `daysOverdue` is the `of_Days_Overdue__c` formula-number. The sandbox held
// 0 `Repair__c` rows at 2026-05-20 (Q-R3). The adapter carries every repair
// row unfiltered; the open-status + Post-Move-In trigger logic is the engine's
// job (`createOpenRepairInvariant`).
export interface RepairSnapshot {
  readonly id: string;
  readonly programEnrollmentId: string | null;
  readonly status: string | null;
  readonly preOrPostMoveIn: string | null;
  readonly completedDate: Date | null;
  readonly dueDate: Date | null;
  readonly identificationDate: Date | null;
  readonly urgency: string | null;
  readonly daysOverdue: number | null;
}

// Incident — hydrated through the `Incident_Participant__c` junction
// (`Incident__c` has no direct participant FK; P0-08d). `id` is the
// `Incident__c` record Id; `incidentDate` is `Incident_Start_Date_Time__c`;
// `critical` is the `Critical_Incident__c` formula checkbox, a severity-tier
// proxy until Erik confirms a dedicated severity field.
export interface IncidentSnapshot {
  readonly id: string;
  readonly incidentType: string | null;
  readonly status: string | null;
  readonly incidentDate: Date | null;
  readonly critical: boolean;
}

// SalesforceAuth abstracts the token-acquisition path so the Phase 0 `sf` CLI
// implementation can be swapped for per-specialist OAuth+PKCE refresh tokens
// when F-01 (Phase 1) lands. Immutable #3 stays preserved at both layers —
// PKCE flow happens at credential-issue time, this interface only carries
// the bearer token forward.
export interface SalesforceAuth {
  getAccessToken(): Promise<string>;
  getInstanceUrl(): Promise<string>;
}

export interface BulkHydrationOptions {
  readonly auth?: SalesforceAuth;
  readonly incidentWindowDays?: number;
  readonly apiVersion?: string;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => Date;
}

// Result includes round-trip metering so TR-SF-2 cost-validation tests can
// assert ≤2 round-trips per caseload.
export interface BulkHydrationResult {
  readonly snapshots: ReadonlyArray<CaseloadSnapshot>;
  readonly roundTrips: number;
  readonly hydratedAt: Date;
}

export type SalesforceErrorCode =
  | "SF_AUTH_FAILED"
  | "SF_TOKEN_EXPIRED"
  | "SF_QUOTA_EXCEEDED"
  | "SF_GOVERNOR_LIMIT"
  | "SF_NETWORK_TIMEOUT"
  | "SF_FIELD_FLS_DENIED"
  | "SF_QUERY_INVALID"
  // DML rejection covering REQUIRED_FIELD_MISSING, STRING_TOO_LONG,
  // INVALID_TYPE_ON_FIELD_IN_RECORD, FIELD_CUSTOM_VALIDATION_EXCEPTION, and
  // similar Salesforce write-side validation codes (P1E-01).
  | "SF_VALIDATION_FAILED"
  // Ownership / state changed mid-write: SF returned INVALID_CROSS_REFERENCE_KEY
  // (referenced record no longer accessible — typically a caseload reassignment
  // mid-flight) or ENTITY_IS_DELETED (target soft-deleted). Both surface to
  // clients as 409 UPSTREAM_STATE_CHANGED with a per-code `suggestedResolution`
  // envelope (API v1.3 §7.4.3 line 940, §9.2.1 line 2172). The underlying SF
  // errorCode is preserved on `SalesforceError.sfErrorCode` so handlers can
  // derive `suggestedResolution` without parsing the message.
  | "SF_UPSTREAM_STATE_CHANGED"
  | "SF_UNKNOWN";

export class SalesforceError extends Error {
  readonly code: SalesforceErrorCode;
  readonly statusCode: number | undefined;
  // Raw Salesforce `errorCode` from the response body, when present. Optional
  // because non-HTTP failures (timeouts, empty bodies) have no SF code.
  // Used by handlers to derive 409 UPSTREAM_STATE_CHANGED `suggestedResolution`
  // (INVALID_CROSS_REFERENCE_KEY → ESCALATE_TO_SUPERVISOR, ENTITY_IS_DELETED →
  // DISCARD) without re-parsing `message`.
  readonly sfErrorCode: string | undefined;

  constructor(
    code: SalesforceErrorCode,
    message: string,
    statusCode?: number,
    sfErrorCode?: string,
  ) {
    super(message);
    this.name = "SalesforceError";
    this.code = code;
    this.statusCode = statusCode;
    this.sfErrorCode = sfErrorCode;
  }
}
