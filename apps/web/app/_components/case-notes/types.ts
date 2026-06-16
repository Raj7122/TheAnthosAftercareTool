// Shared types + dropdown options for the Log Case Note sheet and its optimistic
// surfaces. Mirrors the repair component module. The picklist option lists are
// hardcoded here (not value-imported from `@anthos/api`) to keep `pg` out of the
// client bundle — the server re-validates every value against the same set.

export interface CreateCaseNoteInput {
  readonly note: string;
  readonly contactType: string;
  readonly type: string;
  readonly status: string;
}

// A case note logged this session, surfaced optimistically (caseload calendar +
// participant timeline). "via tool" client record — the authoritative row is the
// IDW_Case_Note__c the BFF wrote. Reset on reload; never persisted.
export interface OptimisticCaseNote {
  readonly caseNoteId: string;
  readonly participantId: string;
  // Captured at create time so a caseload-wide calendar event can label +
  // deep-link the note. Null when unknown.
  readonly participantName: string | null;
  // UTC YYYY-MM-DD the note's Service Date (server-set to today).
  readonly serviceDate: string;
  readonly note: string;
  readonly contactType: string;
  readonly type: string;
  readonly status: string;
  readonly loggedAt: string;
}

// Real IDW_Case_Note__c picklist values (verified via SF describe 2026-06-04).
export const CONTACT_TYPE_OPTIONS = [
  "In Person",
  "Phone",
  "Email",
  "Zoom/Virtual",
  "Text/SMS",
] as const;

export const TYPE_OPTIONS = [
  "Check In",
  "Stability Meeting",
  "Specialized Support Meeting",
  "Safety Plan",
  "Client Case Conference",
  "Communications/Story Sharing",
  "Other",
] as const;

export const STATUS_OPTIONS = [
  "Completed",
  "Attempted",
  "Scheduled",
  "Rescheduled",
  "Canceled",
  "Seen by Other Provider",
] as const;

export type { MutationFailure } from "../../caseload/_lib/send-mutation";
