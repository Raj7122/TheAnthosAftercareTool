// Caseload activity reads (F-23 Phase B). Powers the read-only
// `GET /api/v1/caseload/activity` BFF endpoint: the specialist's owned
// participants, then their dated activity (case notes + Mogli SMS) in a date
// window — METADATA ONLY (no message bodies, no case-note text). The SOQL lives
// here beside `bulk-hydration.ts` so the IN-clause + composite-batch posture is
// shared; the API layer owns the wire DTO + channel mapping.
//
// Runtime-confirmed (anthos-demo, 2026-06-03): `IDW_Case_Note__c` and
// `Mogli_SMS__SMS__c` both carry a queryable `Program_Enrollment__c` lookup
// (the earlier "no PE link" audit was an FLS artifact, corrected 2026-05-26 in
// P0-08g). `Service_Date__c` is date-only and 100% populated on PE-linked rows.

import { SalesforceRestClient } from "./rest-client.js";
import type { SoqlQueryResponse } from "./rest-client.js";
import { assertSalesforceId, buildIdInClause } from "./soql.js";
import { SalesforceError } from "./types.js";

// The specialist's owned, in-aftercare Program Enrollments — the exact
// membership predicate `hydrateCaseload` uses, so the activity layer can never
// surface events for a participant the caseload itself would not show.
export interface OwnedEnrollment {
  readonly id: string;
  // `Contact__r.Name` is PII — wire-only on the activity response, never cached
  // or logged (same posture as the caseload `displayName`).
  readonly name: string | null;
}

// Raw activity rows. Bodies (`Case_Note__c`, `Mogli_SMS__Message__c`) are
// deliberately NOT selected — the calendar plots metadata only.
export interface CaseNoteActivityRecord {
  readonly Id: string;
  readonly Program_Enrollment__c: string;
  readonly Type__c: string | null;
  readonly Status__c: string | null;
  readonly Contact_Type__c: string | null;
  readonly Service_Date__c: string | null; // YYYY-MM-DD
}

export interface SmsActivityRecord {
  readonly Id: string;
  readonly Program_Enrollment__c: string;
  readonly Mogli_SMS__Direction__c: string | null;
  readonly Mogli_SMS__Status__c: string | null;
  readonly CreatedDate: string; // ISO 8601 datetime
}

export interface CaseloadActivityRecords {
  readonly caseNotes: ReadonlyArray<CaseNoteActivityRecord>;
  readonly sms: ReadonlyArray<SmsActivityRecord>;
}

interface OwnedEnrollmentRecord {
  readonly Id: string;
  readonly Contact__r: { readonly Name: string | null } | null;
}

// Guards a `YYYY-MM-DD` before interpolating it into a SOQL date/datetime
// literal (SOQL dates are unquoted, so they can't go through `escapeSoqlString`).
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
function assertIsoDate(value: string, label: string): void {
  if (!ISO_DATE.test(value)) {
    throw new SalesforceError("SF_QUERY_INVALID", `${label} is not a YYYY-MM-DD date`);
  }
}

export async function queryOwnedEnrollments(
  ownerId: string,
  restClient: SalesforceRestClient,
): Promise<ReadonlyArray<OwnedEnrollment>> {
  assertSalesforceId(ownerId, "ownerId");
  const soql =
    `SELECT Id, Contact__r.Name ` +
    `FROM IDW_Program_Enrollment__c ` +
    `WHERE Aftercare_Owner__c = '${ownerId}' ` +
    `AND RecordType.DeveloperName = 'Matching' ` +
    `AND Inactive__c = false ` +
    `AND Date_of_Withdrawal_or_Graduation__c = null`;
  const resp = await restClient.queryAll<OwnedEnrollmentRecord>(soql);
  return resp.records.map((r) => ({
    id: r.Id,
    name: r.Contact__r?.Name ?? null,
  }));
}

export interface CaseloadActivityQueryArgs {
  readonly peIds: ReadonlyArray<string>;
  readonly fromDate: string; // YYYY-MM-DD (inclusive)
  readonly toDate: string; // YYYY-MM-DD (inclusive)
  readonly restClient: SalesforceRestClient;
}

// Case notes + Mogli SMS for the given PEs in [fromDate, toDate], in one
// composite-batch round-trip. Case notes filter on the date-only
// `Service_Date__c`; SMS on the datetime `CreatedDate` (widened to day bounds).
//
// CAVEAT (inherited from `compositeBatch`): sub-results do not auto-paginate —
// truncated at 2000 rows per sub-query. At the TR-SF-2 ~75-participant scale
// over a ≤92-day window this is well within budget (cost-validated). A wider
// window or Production scale-up would need per-sub-result follow-up.
export async function queryCaseloadActivityRecords(
  args: CaseloadActivityQueryArgs,
): Promise<CaseloadActivityRecords> {
  const { peIds, fromDate, toDate, restClient } = args;
  if (peIds.length === 0) {
    return { caseNotes: [], sms: [] };
  }
  assertIsoDate(fromDate, "fromDate");
  assertIsoDate(toDate, "toDate");
  const peInClause = buildIdInClause(peIds);

  const caseNoteSoql =
    `SELECT Id, Program_Enrollment__c, Type__c, Status__c, Contact_Type__c, Service_Date__c ` +
    `FROM IDW_Case_Note__c ` +
    `WHERE Program_Enrollment__c IN (${peInClause}) ` +
    `AND Service_Date__c >= ${fromDate} AND Service_Date__c <= ${toDate}`;

  const smsSoql =
    `SELECT Id, Program_Enrollment__c, Mogli_SMS__Direction__c, Mogli_SMS__Status__c, CreatedDate ` +
    `FROM Mogli_SMS__SMS__c ` +
    `WHERE Program_Enrollment__c IN (${peInClause}) ` +
    `AND CreatedDate >= ${fromDate}T00:00:00Z AND CreatedDate <= ${toDate}T23:59:59Z`;

  const batch = await restClient.compositeBatch([caseNoteSoql, smsSoql]);
  if (batch.hasErrors) {
    const failure = batch.results.find((r) => r.statusCode >= 400);
    const message =
      (failure?.result as { message?: string } | undefined)?.message ??
      "composite batch returned errors";
    throw new SalesforceError("SF_QUERY_INVALID", message, failure?.statusCode);
  }

  const caseNotes = (
    batch.results[0] as { result: SoqlQueryResponse<CaseNoteActivityRecord> }
  ).result.records;
  const sms = (
    batch.results[1] as { result: SoqlQueryResponse<SmsActivityRecord> }
  ).result.records;

  return { caseNotes, sms };
}
