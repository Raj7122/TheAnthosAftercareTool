// SF identity hydration for E-08 (P1F-01). One SOQL round-trip against
// `IDW_Program_Enrollment__c` to resolve the participant identity surface for
// the detail view + the `Aftercare_Owner__c` the authz gate compares against.
//
// All fields are read from PE itself — anthos-demo introspection (P0-08d)
// confirms PE
// carries identity as formula fields, so this avoids a Contact-object read
// scope. `Most_Recent_Case_Note_*` rollups are read so the detail DTO can
// surface a single-row `recentContacts[]` — `IDW_Case_Note__c` itself has no
// PE link (P0-08d), so the broader top-N timeline cannot be sourced today.

import {
  SalesforceRestClient,
  assertSalesforceId,
  escapeSoqlString,
  type SalesforceAuth,
} from "@anthos/integrations";

// Fields selected from the live `IDW_Program_Enrollment__c` schema. Every name
// below is verified against the anthos-demo sandbox per P0-08d's 341-field
// enumeration. Identity formula fields (`Full_Name__c`, `Phone_Number__c`,
// `Primary_Contact_s_Email__c`) and the `Most_Recent_Case_Note_*` rollups are
// the v1.4 additions over the caseload's `ENROLLMENT_FIELDS`.
const IDENTITY_FIELDS = [
  "Id",
  "Name",
  "Aftercare_Owner__c",
  "Full_Name__c",
  "Phone_Number__c",
  "Primary_Contact_s_Email__c",
  "Aftercare_Start_Date__c",
  "Program_Enrollment_Outcome__c",
  "Most_Recent_Case_Note__c",
  "Most_Recent_Case_Note_Status__c",
  "Most_Recent_Case_Note_Type__c",
  "Most_Recent_Case_Note_Text__c",
].join(", ");

// Raw record shape from the SOQL response. Salesforce returns formula nulls as
// JSON `null`; the Date/Date-Time formulas (`Most_Recent_Case_Note__c`) come
// back as ISO strings.
interface IdentityRecord {
  Id: string;
  Name: string | null;
  Aftercare_Owner__c: string | null;
  Full_Name__c: string | null;
  Phone_Number__c: string | null;
  Primary_Contact_s_Email__c: string | null;
  Aftercare_Start_Date__c: string | null;
  Program_Enrollment_Outcome__c: string | null;
  Most_Recent_Case_Note__c: string | null;
  Most_Recent_Case_Note_Status__c: string | null;
  Most_Recent_Case_Note_Type__c: string | null;
  Most_Recent_Case_Note_Text__c: string | null;
}

// Typed projection consumed by `participants/dto.ts`. Dates are parsed up-front
// so the DTO layer never re-parses Salesforce's ISO strings.
export interface ParticipantIdentity {
  readonly participantId: string;
  readonly enrollmentCode: string | null;
  readonly aftercareOwnerId: string | null;
  readonly displayName: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly aftercareStartDate: Date | null;
  readonly programEnrollmentOutcome: string | null;
  readonly mostRecentCaseNote: {
    readonly date: Date | null;
    readonly status: string | null;
    readonly type: string | null;
    readonly summary: string | null;
  };
}

export interface HydrateIdentityOptions {
  readonly restClient?: SalesforceRestClient;
  readonly auth?: SalesforceAuth;
}

// Resolves the SF REST client. A test-injected `restClient` wins; otherwise the
// caller-provided `auth` is wrapped, otherwise the live default is constructed.
function resolveClient(options: HydrateIdentityOptions): SalesforceRestClient {
  if (options.restClient !== undefined) return options.restClient;
  if (options.auth !== undefined) {
    return new SalesforceRestClient({ auth: options.auth });
  }
  throw new Error(
    "hydrateParticipantIdentity: either `restClient` or `auth` must be supplied",
  );
}

// Returns the parsed identity row, or `null` when the PE Id does not resolve to
// a row (the caller renders this as a 404). Throws `SalesforceError` on any
// transport / query failure — the caller maps it to the §9 catalog response.
export async function hydrateParticipantIdentity(
  participantId: string,
  options: HydrateIdentityOptions,
): Promise<ParticipantIdentity | null> {
  // Belt-and-braces: `escapeSoqlString` would handle a malformed id, but
  // `assertSalesforceId` rejects shape errors as a structured 422 instead.
  assertSalesforceId(participantId, "participantId");

  const client = resolveClient(options);
  const soql =
    `SELECT ${IDENTITY_FIELDS} ` +
    `FROM IDW_Program_Enrollment__c ` +
    `WHERE Id = '${escapeSoqlString(participantId)}' LIMIT 1`;
  const result = await client.query<IdentityRecord>(soql);
  const record = result.records[0];
  if (record === undefined) return null;
  return mapRecord(record);
}

function mapRecord(record: IdentityRecord): ParticipantIdentity {
  return {
    participantId: record.Id,
    enrollmentCode: record.Name,
    aftercareOwnerId: record.Aftercare_Owner__c,
    displayName: record.Full_Name__c,
    phone: record.Phone_Number__c,
    email: record.Primary_Contact_s_Email__c,
    aftercareStartDate: parseDate(record.Aftercare_Start_Date__c),
    programEnrollmentOutcome: record.Program_Enrollment_Outcome__c,
    mostRecentCaseNote: {
      date: parseDate(record.Most_Recent_Case_Note__c),
      status: record.Most_Recent_Case_Note_Status__c,
      type: record.Most_Recent_Case_Note_Type__c,
      summary: record.Most_Recent_Case_Note_Text__c,
    },
  };
}

// `new Date(null)` is epoch — null/empty values must short-circuit so the
// downstream DTO sees a true null. Matches `bulk-hydration.ts` `parseDate`.
function parseDate(value: string | null | undefined): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
