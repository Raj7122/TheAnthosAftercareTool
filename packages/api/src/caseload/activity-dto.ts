// Wire DTO for the caseload activity endpoint (F-23 Phase B, E-46). METADATA
// ONLY: each event carries who/when/what-kind/status — never a message body or
// case-note text (PII firewall). `participantName` is the one PII field, wire-
// only (never cached, never logged), mirroring the caseload `displayName`.

// Calendar channel kinds (a subset of the SPA's CalendarEventKind — the
// cache-derived checkpoint / visit_due / barrier kinds are Phase A's).
export type CaseloadActivityKind = "visit" | "phone" | "sms" | "email";

// Normalized status, lowercased from the SF `Status__c` / Mogli status so the
// SPA renders "scheduled vs completed" without parsing free-form SF strings.
export type CaseloadActivityStatus =
  | "scheduled"
  | "completed"
  | "attempted"
  | "canceled"
  | "rescheduled"
  | "queued"
  | "error"
  | "other";

export interface CaseloadActivityEvent {
  // Namespaced by participant + source so it never collides with Phase A's
  // cache-derived event ids: "<peId>:cn-<sfId>" | "<peId>:sms-<sfId>".
  readonly id: string;
  readonly participantId: string;
  readonly participantName: string | null;
  readonly ymd: string; // UTC YYYY-MM-DD
  readonly kind: CaseloadActivityKind;
  readonly status: CaseloadActivityStatus;
  // Human label composed from the case-note Type (or "SMS") + nothing else —
  // no body/note text. e.g. "Stability Meeting", "Check In", "SMS".
  readonly label: string;
}

export interface CaseloadActivityBody {
  readonly items: ReadonlyArray<CaseloadActivityEvent>;
  readonly window: { readonly from: string; readonly to: string };
  // Mirrors E-09's affordance — empty today; reserved for future degraded
  // signals (e.g. a truncated sub-query) so the SPA can surface a note.
  readonly dataIssues: ReadonlyArray<string>;
}
