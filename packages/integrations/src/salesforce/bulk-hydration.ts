import { SfCliKeychainAuth } from "./auth.js";
import { SalesforceRestClient, type SoqlQueryResponse } from "./rest-client.js";
import { assertSalesforceId, buildIdInClause } from "./soql.js";
import {
  SalesforceError,
  type ArrearSnapshot,
  type BarrierSnapshot,
  type BulkHydrationOptions,
  type BulkHydrationResult,
  type CaseloadSnapshot,
  type IncidentSnapshot,
  type RepairSnapshot,
  type SalesforceAuth,
} from "./types.js";

// TR-SF-1 / TR-SF-2 — bulk hydration of a specialist's caseload in ≤2 round-
// trips. Round 1 fetches the IDW_Program_Enrollment__c parents. Round 2
// fetches the four sibling collections (open Barriers + recent Incidents +
// Arrears + Repairs) in a single SF composite/batch HTTP call.
//
// Reconciled against the live `anthos-demo` schema by P0-08d. Three of
// P0-08's four
// original queries named columns that do not exist; the corrected shape is:
//  - Parent: the caseload is keyed by `Aftercare_Owner__c` (the assigned
//    Aftercare Specialist, FS v1.12 §F-03) and bounded by RecordType
//    'Matching' — the in-aftercare condition Anthos's "My Participants In
//    Aftercare" report uses. There is no `Status__c` field. (FS v1.12 BR-08
//    names both `OwnerId` and a non-existent `Status` field — erratum pending.)
//  - Barriers: hang off the PE Master-Detail FK `Program_Enrollment__c` — the
//    one sibling query P0-08 got right.
//  - Incidents: `Incident__c` has NO direct PE FK. Incidents reach a
//    participant through the `Incident_Participant__c` junction, keyed by
//    `Contact__c` — so the incident sub-query filters on the parents' Contact
//    Ids and reads Incident fields through the junction's `Incident__r`.
//  - Arrears: `Arrear__c` hangs off the PE Lookup FK `Program_Enrollment__c`,
//    like Barriers. P0-08b added this sibling for the BR-19(g) factor data
//    path; the adapter carries every arrear row unfiltered (the factor swap
//    is the separate P0-08c ticket).
//  - Repairs: `Repair__c` has NO direct PE FK — it reaches a participant two
//    hops out via `Unit_Rental__r.Program_Enrollment__c`. A nested child
//    subquery is impossible (two levels of child nesting), so the sub-query
//    filters on the two-hop parent field. P0-04e added this sibling for the
//    BR-25 open-repair invariant; the adapter carries every repair row
//    unfiltered (open-status / Post-Move-In logic is the engine's job).
//  - The former `IDW_Case_Note__c` sibling query was dropped: that object has
//    no participant link. BR-19(c) `failed_attempts` is sourced instead from
//    PE check-in rollup counts carried on the parent query.

const DEFAULT_INCIDENT_WINDOW_DAYS = 60;

// IDW_Program_Enrollment__c — engine-relevant fields, all verified present on
// the live `anthos-demo` schema (P0-08d). The `Inactive__c`,
// `Date_of_Withdrawal_or_Graduation__c`, and `RecordType` fields used by the
// caseload filter are WHERE-only and intentionally not selected.
const ENROLLMENT_FIELDS = [
  "Id",
  "Aftercare_Owner__c",
  // P1H-01 display plumbing for the F-02 caseload-row redesign. `Name` and
  // `Client_Type__c` are PII-free (label/code). `Contact__r.Name` IS PII —
  // wire-only; `stripPiiForCache` in dto.ts nulls it before `caseload_cache`
  // writes per Immutable #1. `Client_Type__c` is a multi-select picklist;
  // raw values are exposed as-is (semicolon-joined when multi-value).
  // Source verified 2026-05-25 via SF MCP probe on `anthos-demo`.
  "Name",
  "Client_Type__c",
  "Contact__r.Name",
  // GAP-5 field-side closed 2026-05-19 via SF MCP introspection. Formula (Date):
  //   IF(Contact__r.Most_Recent_Email__c > Contact__r.Most_Recent_Successful_Case_Note__c,
  //      Contact__r.Most_Recent_Email__c,
  //      Contact__r.Most_Recent_Successful_Case_Note__c)
  // Label "Most Recent Successful Contact". Path A/B/C ratification still
  // leadership-owned via GAP-9 / BR-21.
  "Most_Recent_Successful_Contact__c",
  "Aftercare_Start_Date__c",
  "Aftercare_End_Date__c",
  "Aftercare_Extension_End_Date__c",
  "Aftercare_First_Due_Date__c",
  "Aftercare_Second_Due_Date__c",
  "Aftercare_Third_Due_Date__c",
  "Aftercare_Fourth_Due_Date__c",
  "Upcoming_Aftercare_Visit_Due_Date__c",
  "Program_Enrollment_Outcome__c",
  "Contact__c",
  "Account__c",
  // BR-19(i) voucher recert deadline. GAP-17 closed 2026-05-19 by Julia:
  // authoritative source is the SF-side formula
  //   IF(CONTAINS(Voucher__r.Name,'HASA'),
  //      Aftercare_End_Date__c,
  //      Aftercare_End_Date__c - 60)
  // Label "Subsidy Renewal Due Date".
  "Subsidy_Renewal_Re_Cert_Due_Date__c",
  // BR-19(c) failed_attempts candidate source — PE check-in rollup counts.
  // The dropped IDW_Case_Note__c query previously backed factor (c); these
  // PE fields are its only viable replacement (P0-08d). How the engine
  // derives the factor from them is an open P0-04 decision. Note the
  // API-name asymmetry: `Num_of_...Attempted` vs `Number_of_...Completed`.
  "Num_of_Aftercare_Check_Ins_Attempted__c",
  "Number_of_Aftercare_Check_Ins_Completed__c",
  "Number_of_Missed_Check_Ins__c",
].join(", ");

// `Days_Since_Last_Update__c` is a Formula (Number) — `TODAY() - Last_Updated__c`
// with BlankAsZero (MCP-confirmed against anthos-demo 2026-05-23). Engine
// consumes it for BR-39 staleness multiplier (FS §723, TRD TR-BAR-3).
const BARRIER_FIELDS =
  "Id, Program_Enrollment__c, Type__c, Status__c, Stage__c, Start_Date__c, End_Date__c, Days_Since_Last_Update__c";

// BR-19(g) arrears signal (data path only — P0-08b). `Arrear__c` is the
// canonical Arrears object: API name singular, Object Manager label "Arrears"
// plural; direct Lookup FK `Program_Enrollment__c` to IDW_Program_Enrollment__c.
// PII fields (`Notes__c`, `Submitter__c`, `Submitter_Email__c`,
// `Description_FormAssembly__c`, `Household_Share__c`) are intentionally
// EXCLUDED. All 12 field names below were validated against the live
// `anthos-demo` schema 2026-05-19 (a `SELECT ... FROM Arrear__c LIMIT 1`
// returned 0 rows with no "No such column" error; integration-user FLS read
// confirmed). `Length_of_Time_Months_Formula__c` is the live formula-number
// API name, not the deprecated `DEPRECATED_Length_of_Time_Months__c`.
const ARREAR_FIELDS =
  "Id, Program_Enrollment__c, Unit_Engagement__c, Status__c, " +
  "Date_Identified__c, Date_Resolved__c, Arrears_Start_Date__c, " +
  "Arrears_End_Date__c, Arrears_Purpose__c, Estimated_Amount__c, " +
  "Amount_Paid__c, Length_of_Time_Months_Formula__c";

// BR-25 open-repair invariant data source (P0-04e). `Repair__c` has no direct
// PE FK — `programEnrollmentId` is read through the `Unit_Rental__r` parent
// relationship. `of_Days_Overdue__c` is the live API name of the "# of Days
// Overdue" formula (Salesforce strips the leading `#`). All field names were
// verified against the live `anthos-demo` schema 2026-05-20.
const REPAIR_FIELDS =
  "Id, Status__c, Pre_or_Post_Move_In__c, Completed_Date__c, Due_Date__c, " +
  "Identification_Date__c, Urgency__c, of_Days_Overdue__c, " +
  "Unit_Rental__r.Program_Enrollment__c";

// Incident__c carries no direct participant FK — its fields are reached
// through the `Incident_Participant__c` junction's `Incident__r` relationship.
const INCIDENT_PARTICIPANT_FIELDS =
  "Id, Contact__c, Incident__c, Role__c, " +
  "Incident__r.Incident_Type__c, Incident__r.Status__c, " +
  "Incident__r.Critical_Incident__c, Incident__r.Incident_Start_Date_Time__c";

interface EnrollmentRecord {
  Id: string;
  // P1H-01: PE display label (e.g., "GRAD John Stone - 09/2023"). The DTO
  // layer extracts the trailing date suffix as `peLabel` and exposes the raw
  // value as `peName` on the snapshot.
  Name: string;
  // P1H-01: program-code (Multi-Select Picklist). Raw semicolon-joined values
  // pass through; SPA decides multi-value rendering.
  Client_Type__c: string | null;
  // P1H-01: Contact display name (PII). Wire-only — stripped before cache
  // write via `stripPiiForCache(body)` in dto.ts.
  Contact__r: { Name: string | null } | null;
  Aftercare_Owner__c: string | null;
  Most_Recent_Successful_Contact__c: string | null;
  Aftercare_Start_Date__c: string | null;
  Aftercare_End_Date__c: string | null;
  Aftercare_Extension_End_Date__c: string | null;
  Aftercare_First_Due_Date__c: string | null;
  Aftercare_Second_Due_Date__c: string | null;
  Aftercare_Third_Due_Date__c: string | null;
  Aftercare_Fourth_Due_Date__c: string | null;
  Upcoming_Aftercare_Visit_Due_Date__c: string | null;
  Program_Enrollment_Outcome__c: string | null;
  Contact__c: string | null;
  Account__c: string | null;
  Subsidy_Renewal_Re_Cert_Due_Date__c: string | null;
  Num_of_Aftercare_Check_Ins_Attempted__c: number | null;
  Number_of_Aftercare_Check_Ins_Completed__c: number | null;
  Number_of_Missed_Check_Ins__c: number | null;
}

interface BarrierRecord {
  Id: string;
  Program_Enrollment__c: string | null;
  Type__c: string | null;
  Status__c: string | null;
  Stage__c: string | null;
  Start_Date__c: string | null;
  End_Date__c: string | null;
  Days_Since_Last_Update__c: number | null;
}

// `Arrear__c` raw SOQL row (P0-08b). Dates, picklists, and lookup-Ids come
// back as strings; the two currency fields (`Estimated_Amount__c`,
// `Amount_Paid__c`) and the formula-number (`Length_of_Time_Months_Formula__c`)
// come back as numbers. All nullable except `Id`.
interface ArrearRecord {
  Id: string;
  Program_Enrollment__c: string | null;
  Unit_Engagement__c: string | null;
  Status__c: string | null;
  Date_Identified__c: string | null;
  Date_Resolved__c: string | null;
  Arrears_Start_Date__c: string | null;
  Arrears_End_Date__c: string | null;
  Arrears_Purpose__c: string | null;
  Estimated_Amount__c: number | null;
  Amount_Paid__c: number | null;
  Length_of_Time_Months_Formula__c: number | null;
}

// `Repair__c` raw SOQL row (P0-04e). Dates and picklists come back as strings;
// `of_Days_Overdue__c` comes back as a number. `Unit_Rental__r` is the
// parent-relationship projection — Salesforce returns it as a nested object,
// or `null` when the `Unit_Rental__c` lookup is empty. All fields nullable
// except `Id`.
interface RepairRecord {
  Id: string;
  Status__c: string | null;
  Pre_or_Post_Move_In__c: string | null;
  Completed_Date__c: string | null;
  Due_Date__c: string | null;
  Identification_Date__c: string | null;
  Urgency__c: string | null;
  of_Days_Overdue__c: number | null;
  Unit_Rental__r: { Program_Enrollment__c: string | null } | null;
}

// `Incident_Participant__c` junction row. Salesforce returns the `Incident__r`
// parent-relationship projection as a nested object, or `null` when the
// junction's `Incident__c` lookup is empty.
interface IncidentParticipantRecord {
  Id: string;
  Contact__c: string | null;
  Incident__c: string | null;
  Role__c: string | null;
  Incident__r: {
    Incident_Type__c: string | null;
    Status__c: string | null;
    Critical_Incident__c: boolean | null;
    Incident_Start_Date_Time__c: string | null;
  } | null;
}

export async function hydrateCaseload(
  ownerId: string,
  options: BulkHydrationOptions = {},
): Promise<BulkHydrationResult> {
  assertSalesforceId(ownerId, "ownerId");

  const auth: SalesforceAuth = options.auth ?? new SfCliKeychainAuth();
  const client = new SalesforceRestClient({
    auth,
    ...(options.apiVersion === undefined ? {} : { apiVersion: options.apiVersion }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });
  const now = options.now ?? (() => new Date());
  const incidentWindowDays = assertPositiveInteger(
    options.incidentWindowDays ?? DEFAULT_INCIDENT_WINDOW_DAYS,
    "incidentWindowDays",
  );

  // Round-trip 1: parents. `ownerId` is Id-shape-validated above (safe to
  // interpolate). The caseload is the specialist's in-aftercare Program
  // Enrollments — keyed by `Aftercare_Owner__c`, bounded by RecordType
  // 'Matching'; the `Inactive__c` / withdrawal-date clauses are defensive
  // exclusions that survive the Production substrate.
  const enrollmentSoql =
    `SELECT ${ENROLLMENT_FIELDS} ` +
    `FROM IDW_Program_Enrollment__c ` +
    `WHERE Aftercare_Owner__c = '${ownerId}' ` +
    `AND RecordType.DeveloperName = 'Matching' ` +
    `AND Inactive__c = false ` +
    `AND Date_of_Withdrawal_or_Graduation__c = null`;
  const enrollments = await client.queryAll<EnrollmentRecord>(enrollmentSoql);

  if (enrollments.records.length === 0) {
    return {
      snapshots: [],
      roundTrips: client.roundTripCount,
      hydratedAt: now(),
    };
  }

  const participantIds = enrollments.records.map((r) => r.Id);
  const peInClause = buildIdInClause(participantIds);

  // Incidents are keyed by Contact, not PE — collect the parents' distinct
  // Contact Ids for the junction query.
  const contactIds = [
    ...new Set(
      enrollments.records
        .map((r) => r.Contact__c)
        .filter((c): c is string => typeof c === "string" && c.length > 0),
    ),
  ];

  // Round-trip 2: sibling collections in one composite/batch HTTP call. The
  // incident sub-query is included only when the caseload has ≥1 Contact Id —
  // an empty `IN ()` is a malformed query.
  const barrierSoql =
    `SELECT ${BARRIER_FIELDS} ` +
    `FROM Barriers__c ` +
    `WHERE Program_Enrollment__c IN (${peInClause}) ` +
    `AND End_Date__c = null`;
  const incidentSoql =
    contactIds.length > 0
      ? `SELECT ${INCIDENT_PARTICIPANT_FIELDS} ` +
        `FROM Incident_Participant__c ` +
        `WHERE Contact__c IN (${buildIdInClause(contactIds)}) ` +
        `AND Incident__r.Incident_Start_Date_Time__c >= LAST_N_DAYS:${incidentWindowDays}`
      : null;
  // Arrears hang off the PE Lookup FK `Program_Enrollment__c`, like Barriers,
  // so this sub-query is always present here (we are past the 0-enrollment
  // early return). No status/date filter — BR-19(g) status/recency factor
  // logic is the engine's job (P0-08c); the adapter carries every arrear row.
  const arrearSoql =
    `SELECT ${ARREAR_FIELDS} ` +
    `FROM Arrear__c ` +
    `WHERE Program_Enrollment__c IN (${peInClause})`;
  // Repairs reach the PE two hops out via `Unit_Rental__r.Program_Enrollment__c`
  // (P0-04e). Always present here (we are past the 0-enrollment early return);
  // a nested child subquery is impossible, so this filters the two-hop parent
  // field. No status/Pre-Post filter — the BR-25 invariant logic is the
  // engine's job; the adapter carries every repair row.
  const repairSoql =
    `SELECT ${REPAIR_FIELDS} ` +
    `FROM Repair__c ` +
    `WHERE Unit_Rental__r.Program_Enrollment__c IN (${peInClause})`;

  // The incident sub-query is the only conditional one — arrears and repairs
  // are appended after it, so incidents keeps index 1 (its conditional
  // extraction is unchanged). `arrearIdx` / `repairIdx` are derived once and
  // adjacently so a future 5th sibling cannot silently collide.
  const arrearIdx = incidentSoql === null ? 1 : 2;
  const repairIdx = arrearIdx + 1;
  const subQueries =
    incidentSoql === null
      ? [barrierSoql, arrearSoql, repairSoql]
      : [barrierSoql, incidentSoql, arrearSoql, repairSoql];
  const batch = await client.compositeBatch(subQueries);

  if (batch.hasErrors) {
    const failure = batch.results.find((r) => r.statusCode >= 400);
    const message =
      (failure?.result as { message?: string } | undefined)?.message ??
      "composite batch returned errors";
    throw new SalesforceError("SF_QUERY_INVALID", message, failure?.statusCode);
  }

  const barriersResp = batch.results[0] as {
    result: SoqlQueryResponse<BarrierRecord>;
  };
  const incidentsResp =
    incidentSoql === null
      ? undefined
      : (batch.results[1] as {
          result: SoqlQueryResponse<IncidentParticipantRecord>;
        });
  // Arrears and repairs always run (PE-keyed, always non-empty here), so unlike
  // `incidentsResp` these are never undefined. `arrearIdx` / `repairIdx` are
  // locally-derived small integers (1|2 and 2|3) — not external input.
  // eslint-disable-next-line security/detect-object-injection -- arrearIdx is a locally-derived 1|2
  const arrearsResp = batch.results[arrearIdx] as {
    result: SoqlQueryResponse<ArrearRecord>;
  };
  // eslint-disable-next-line security/detect-object-injection -- repairIdx is a locally-derived 2|3
  const repairsResp = batch.results[repairIdx] as {
    result: SoqlQueryResponse<RepairRecord>;
  };

  const barriersByParticipant = groupBy(
    barriersResp.result.records,
    (r) => r.Program_Enrollment__c,
  );
  // Incidents attach to a participant (Contact), not an enrollment — two PEs
  // that share a Contact both receive that Contact's incidents, which is
  // correct: incidents follow the person, not the program enrollment.
  const incidentsByContact = groupBy(
    incidentsResp?.result.records ?? [],
    (r) => r.Contact__c,
  );
  // Arrears attach directly to the PE via `Program_Enrollment__c` — same
  // keying as Barriers.
  const arrearsByParticipant = groupBy(
    arrearsResp.result.records,
    (r) => r.Program_Enrollment__c,
  );
  // Repairs reach the PE through `Unit_Rental__r.Program_Enrollment__c` —
  // `groupBy` drops falsy keys, so a repair with a null `Unit_Rental__r` (or a
  // Unit Engagement with no PE) is silently dropped, like the orphan-row paths
  // for incidents and arrears.
  const repairsByParticipant = groupBy(
    repairsResp.result.records,
    (r) => r.Unit_Rental__r?.Program_Enrollment__c ?? null,
  );

  const hydratedAt = now();
  const snapshots: CaseloadSnapshot[] = enrollments.records.map((enrollment) =>
    buildSnapshot(
      enrollment,
      ownerId,
      barriersByParticipant.get(enrollment.Id) ?? [],
      enrollment.Contact__c !== null
        ? incidentsByContact.get(enrollment.Contact__c) ?? []
        : [],
      arrearsByParticipant.get(enrollment.Id) ?? [],
      repairsByParticipant.get(enrollment.Id) ?? [],
      hydratedAt,
    ),
  );

  return {
    snapshots,
    roundTrips: client.roundTripCount,
    hydratedAt,
  };
}

function buildSnapshot(
  enrollment: EnrollmentRecord,
  ownerId: string,
  barriers: ReadonlyArray<BarrierRecord>,
  incidentParticipants: ReadonlyArray<IncidentParticipantRecord>,
  arrears: ReadonlyArray<ArrearRecord>,
  repairs: ReadonlyArray<RepairRecord>,
  hydratedAt: Date,
): CaseloadSnapshot {
  const aftercareEnd = parseDate(enrollment.Aftercare_End_Date__c);
  const extensionEnd = parseDate(enrollment.Aftercare_Extension_End_Date__c);
  // BR-19(h): "Aftercare Extended" — confirmed 2026-05-19 via SF MCP describe
  // of IDW_Program_Enrollment__c (38 Aftercare_* fields, no Aftercare_Extended__c)
  // and live SOQL probe (hard "No such column" rejection). The data model
  // expresses extension as a non-null Extension End Date past the base
  // Aftercare End Date; this derivation is canonical.
  const aftercareExtended =
    extensionEnd !== null &&
    (aftercareEnd === null || extensionEnd.getTime() > aftercareEnd.getTime());

  return {
    participantId: enrollment.Id,
    // Every row in this caseload matched `Aftercare_Owner__c = :ownerId`.
    ownerId,
    hydratedAt,
    enrollment: {
      aftercareOwnerId: enrollment.Aftercare_Owner__c,
      // P1H-01 display plumbing — see field commentary on EnrollmentSnapshot.
      // `displayName` is PII; the cache write path strips it via
      // `stripPiiForCache` in dto.ts.
      peName: enrollment.Name,
      displayName: enrollment.Contact__r?.Name ?? null,
      programCode: enrollment.Client_Type__c,
      mostRecentSuccessfulContact: parseDate(enrollment.Most_Recent_Successful_Contact__c),
      aftercareStartDate: parseDate(enrollment.Aftercare_Start_Date__c),
      aftercareEndDate: aftercareEnd,
      aftercareExtensionEndDate: extensionEnd,
      aftercareExtended,
      dueDates: {
        first: parseDate(enrollment.Aftercare_First_Due_Date__c),
        second: parseDate(enrollment.Aftercare_Second_Due_Date__c),
        third: parseDate(enrollment.Aftercare_Third_Due_Date__c),
        fourth: parseDate(enrollment.Aftercare_Fourth_Due_Date__c),
        upcoming: parseDate(enrollment.Upcoming_Aftercare_Visit_Due_Date__c),
      },
      programEnrollmentOutcome: enrollment.Program_Enrollment_Outcome__c,
      contactId: enrollment.Contact__c,
      accountId: enrollment.Account__c,
      voucherRecertDeadline: parseDate(enrollment.Subsidy_Renewal_Re_Cert_Due_Date__c),
      checkInsAttempted: enrollment.Num_of_Aftercare_Check_Ins_Attempted__c,
      checkInsCompleted: enrollment.Number_of_Aftercare_Check_Ins_Completed__c,
      missedCheckIns: enrollment.Number_of_Missed_Check_Ins__c,
    },
    barriers: barriers.map(
      (b): BarrierSnapshot => ({
        id: b.Id,
        type: b.Type__c,
        status: b.Status__c,
        stage: b.Stage__c,
        startDate: parseDate(b.Start_Date__c),
        endDate: parseDate(b.End_Date__c),
        daysSinceLastUpdate: b.Days_Since_Last_Update__c,
      }),
    ),
    incidents: incidentParticipants.map(
      (ip): IncidentSnapshot => ({
        // The Incident record Id (not the junction-row Id) — the snapshot is
        // "a list of incidents". `ip.Incident__c` is non-null in practice
        // (the query filters on `Incident__r.*`); fall back defensively.
        id: ip.Incident__c ?? ip.Id,
        incidentType: ip.Incident__r?.Incident_Type__c ?? null,
        status: ip.Incident__r?.Status__c ?? null,
        incidentDate: parseDate(ip.Incident__r?.Incident_Start_Date_Time__c),
        critical: ip.Incident__r?.Critical_Incident__c === true,
      }),
    ),
    // BR-19(g) arrears — carried unfiltered (P0-08b). Picklist, lookup-Id, and
    // currency/formula-number values pass through as-is; only the four date
    // fields are coerced via `parseDate`.
    arrears: arrears.map(
      (a): ArrearSnapshot => ({
        id: a.Id,
        programEnrollmentId: a.Program_Enrollment__c,
        unitEngagementId: a.Unit_Engagement__c,
        status: a.Status__c,
        dateIdentified: parseDate(a.Date_Identified__c),
        dateResolved: parseDate(a.Date_Resolved__c),
        arrearsStartDate: parseDate(a.Arrears_Start_Date__c),
        arrearsEndDate: parseDate(a.Arrears_End_Date__c),
        purpose: a.Arrears_Purpose__c,
        estimatedAmount: a.Estimated_Amount__c,
        amountPaid: a.Amount_Paid__c,
        lengthOfTimeMonths: a.Length_of_Time_Months_Formula__c,
      }),
    ),
    // BR-25 repairs — carried unfiltered (P0-04e). `programEnrollmentId` is
    // read through the `Unit_Rental__r` parent relationship; status/picklist
    // values pass through as-is, the three date fields are coerced via
    // `parseDate`.
    repairs: repairs.map(
      (r): RepairSnapshot => ({
        id: r.Id,
        programEnrollmentId: r.Unit_Rental__r?.Program_Enrollment__c ?? null,
        status: r.Status__c,
        preOrPostMoveIn: r.Pre_or_Post_Move_In__c,
        completedDate: parseDate(r.Completed_Date__c),
        dueDate: parseDate(r.Due_Date__c),
        identificationDate: parseDate(r.Identification_Date__c),
        urgency: r.Urgency__c,
        daysOverdue: r.of_Days_Overdue__c,
      }),
    ),
  };
}

function groupBy<T, K extends string | null | undefined>(
  items: ReadonlyArray<T>,
  keyFn: (item: T) => K,
): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    if (typeof key !== "string" || key.length === 0) continue;
    const bucket = map.get(key);
    if (bucket === undefined) {
      map.set(key, [item]);
    } else {
      bucket.push(item);
    }
  }
  return map;
}

// Salesforce returns dates as ISO 8601 strings (`2025-04-04` for Date,
// `2025-04-04T12:34:56.000+0000` for Date/Time). `new Date(null)` returns
// epoch, which would corrupt downstream BR-15 null handling — explicit null
// check first.
function parseDate(value: string | null | undefined): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function assertPositiveInteger(n: number, label: string): number {
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${label} must be a positive integer; got ${n}`);
  }
  return n;
}
