// Wire shapes for POST /api/v1/participants/:id/case-notes — the general
// "Log Case Note" create (sibling to E-10 `…/calls`, which is the phone-only
// façade). Writes a real `IDW_Case_Note__c` row via the DIRECT
// `Program_Enrollment__c` participant lookup. Picklist values below are the
// REAL Salesforce `Contact_Type__c` / `Type__c` / `Status__c` values (verified
// via SF describe 2026-06-04) — note this differs from the Log Call façade's
// `LOG_CALL_TYPES`, which is audit-only and does not write `Type__c`.
//
// GOVERNANCE: case notes are spec'd (E-08/E-09/E-10, IDW_Case_Note__c), but a
// POST create on `…/case-notes` is not in API v1.3 (E-09 there is GET). Flag as
// an intentional endpoint addition.

import { z } from "zod";

// Real `Contact_Type__c` picklist — the channel. Drives the calendar glyph.
export const CASE_NOTE_CONTACT_TYPES = [
  "In Person",
  "Phone",
  "Email",
  "Zoom/Virtual",
  "Text/SMS",
] as const;
export type CaseNoteContactType = (typeof CASE_NOTE_CONTACT_TYPES)[number];

// Curated subset of the real `Type__c` picklist (the aftercare-relevant
// meeting/activity kinds). All values are valid `Type__c` picklist entries.
export const CASE_NOTE_TYPES = [
  "Check In",
  "Stability Meeting",
  "Specialized Support Meeting",
  "Safety Plan",
  "Client Case Conference",
  "Communications/Story Sharing",
  "Other",
] as const;
export type CaseNoteType = (typeof CASE_NOTE_TYPES)[number];

// Real `Status__c` picklist.
export const CASE_NOTE_STATUSES = [
  "Completed",
  "Attempted",
  "Scheduled",
  "Rescheduled",
  "Canceled",
  "Seen by Other Provider",
] as const;
export type CaseNoteStatus = (typeof CASE_NOTE_STATUSES)[number];

// Strict object — unknown keys (incl. a client-supplied `serviceDate`, which is
// server-set to today) yield a 422 VALIDATION_FAILED with the offending key.
export const createCaseNoteRequestSchema = z
  .object({
    note: z
      .string({ required_error: "note is required" })
      .min(1, "note is required")
      .max(32000),
    contactType: z.enum(CASE_NOTE_CONTACT_TYPES, {
      errorMap: () => ({ message: "contactType must be a valid picklist value" }),
    }),
    type: z.enum(CASE_NOTE_TYPES, {
      errorMap: () => ({ message: "type must be a valid picklist value" }),
    }),
    status: z.enum(CASE_NOTE_STATUSES, {
      errorMap: () => ({ message: "status must be a valid picklist value" }),
    }),
  })
  .strict();

export type CreateCaseNoteRequest = z.infer<typeof createCaseNoteRequestSchema>;

// Success body. `note` is echoed back so the SPA can render the optimistic
// timeline row without a re-read; it is response-only and NEVER enters audit
// metadata.
export interface CreateCaseNoteResponseBody {
  readonly caseNoteId: string;
  readonly participantId: string;
  readonly note: string;
  readonly contactType: CaseNoteContactType;
  readonly type: CaseNoteType;
  readonly status: CaseNoteStatus;
  readonly serviceDate: string;
  readonly loggedAt: string;
  readonly loggedBy: string;
}
