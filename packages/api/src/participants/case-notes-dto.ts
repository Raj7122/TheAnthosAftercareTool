// Wire DTO for E-09 (`GET /api/v1/participants/:id/case-notes`) per
// API spec §7.4.2 + §7.1.3 (cursor envelope) + §10.1.
//
// Item shape mirrors §7.4.2 column-by-column. `contactType` is the closed
// enum from ERD v1.4 §2.5 (`Phone | Email | Text | In-Person | Zoom | Other`)
// mapped into the API's snake_case-ish value space; the SF picklist values
// translate on the read path inside the SF adapter, not here.
//
// `dataIssues` is the same affordance as `ParticipantDetailBody.dataIssues`:
// a soft-degradation channel the SPA can render as a banner. The current
// `"schema_gap_no_case_note_pe_link"` value reflects TBD-v1.3-5.

export type CaseNoteContactType =
  | "phone"
  | "email"
  | "text"
  | "in_person"
  | "zoom"
  | "other";

export const CASE_NOTE_CONTACT_TYPES: ReadonlyArray<CaseNoteContactType> = [
  "phone",
  "email",
  "text",
  "in_person",
  "zoom",
  "other",
];

export type CaseNoteSource = "tool" | "salesforce" | "import";

export interface CaseNoteItem {
  readonly caseNoteId: string;
  readonly participantId: string;
  // Case Note Type — open string at the BFF (Data Dictionary owns the enum;
  // see API §7.4.2). Salesforce values flow through verbatim.
  readonly type: string | null;
  readonly contactType: CaseNoteContactType | null;
  readonly status: string | null;
  readonly summary: string | null;
  // ISO date (YYYY-MM-DD) per §7.4.2.
  readonly serviceDate: string | null;
  // ISO 8601 timestamp per §7.4.2.
  readonly occurredAt: string | null;
  // Salesforce Id (User) or display name per Anthos UI convention.
  readonly loggedBy: string | null;
  readonly source: CaseNoteSource;
  // Same as `caseNoteId`; surfaced for client deep-linking convenience
  // (matches v1.0–v1.2 timeline conventions per §7.4.2).
  readonly sfRecordId: string;
}

// Cursor envelope per §7.1.3. `nextCursor` is null on the last page (or, in
// the schema-gap stub, on every page until TBD-v1.3-5 resolves).
export interface CaseNotesPage {
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
  readonly limit: number;
}

// The full E-09 response body.
export interface CaseNotesPageBody {
  readonly items: ReadonlyArray<CaseNoteItem>;
  readonly page: CaseNotesPage;
  readonly dataIssues: ReadonlyArray<string>;
}

// Schema-gap marker surfaced on every response until `IDW_Case_Note__c`
// gains a participant FK (TBD-v1.3-5). When the SF query lights up, this
// constant is the only thing to drop.
export const SCHEMA_GAP_NO_CASE_NOTE_PE_LINK = "schema_gap_no_case_note_pe_link";
