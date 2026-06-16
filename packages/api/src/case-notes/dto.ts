// Wire shapes for E-10 (POST /api/v1/participants/:id/calls) per API v1.3
// §7.4.3 — the F-08 Log-a-Call façade. Path-as-contract: the verb encodes
// `Contact_Type = 'Phone'`; the request body MUST NOT carry a parallel
// `contactType` field (URL-preserving façade per API v1.3 changelog item 6).
//
// Schema-gap stub posture: the underlying Salesforce write target lacks the
// participant FK, contact-type field, service-date field, and a body field
// (P0-08d enumeration, 2026-05-20; `[TBD-v1.3-5]`). Until Erick names the
// canonical write target the handler synthesizes `caseNoteId` and surfaces
// `SCHEMA_GAP_NO_CASE_NOTE_WRITE_TARGET` in `dataIssues`. P1F-03b flips it.
//
// Request shape: API §7.4.3 verbatim. `status` enum includes `SBOP` per
// BR-21 (FS v1.12 line 832 — Path B as deployed); the v1.2 long-form
// "Seen by Other Provider" label is not the wire token. `type` enum holds
// the 7 Aftercare-stage values v1.3 ships; the carry-forward gap to ≥13
// values is Data-Dictionary Part 5 territory.

import { z } from "zod";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

// API §7.4.3 status enum (VR-16). 6 values: 5 picklist + SBOP (BR-21 deployed
// Path B). `SBOP` rides the same scoring posture as `Completed` for now.
export const LOG_CALL_STATUSES = [
  "Completed",
  "Attempted",
  "Scheduled",
  "Rescheduled",
  "Canceled",
  "SBOP",
] as const;
export type LogCallStatus = (typeof LOG_CALL_STATUSES)[number];

// API §7.4.3 type enum (VR-17 per the §7.4.3 field table). 7 values per
// v1.3; canonicalization to ≥13 values is Data-Dictionary Part 5
// (carry-forward gap noted in §7.4.3 changelog). Spec lists
// "Resource referral" / "Crisis support" / "Lease renewal" /
// "Voucher recert support" / "Documentation request" in
// lowercase-after-first-word form — preserved verbatim so the wire surface
// matches the spec exactly.
export const LOG_CALL_TYPES = [
  "Check In",
  "Stability Meeting",
  "Resource referral",
  "Crisis support",
  "Lease renewal",
  "Voucher recert support",
  "Documentation request",
] as const;
export type LogCallType = (typeof LOG_CALL_TYPES)[number];

// VR-18 minimum summary length when status='Completed' (BA VL-01, FS v1.12
// VR-18). BR-45 / VR-19 maximum.
const SUMMARY_MIN_LEN_COMPLETED = 10;
const SUMMARY_MAX_LEN = 2000;

// BR-44 back-date window. API §7.4.3 ("≤ today + 1 day") for next-day
// scheduled. Range is enforced in `runLogCall` against the resolved server
// clock — Zod validates shape, the handler validates the window because the
// clock is request-scoped.
export const SERVICE_DATE_BACKDATE_DAYS = 14;
export const SERVICE_DATE_FORWARD_DAYS = 1;

// ---------------------------------------------------------------------------
// Request schema
// ---------------------------------------------------------------------------

// `serviceDate` is shape-validated here (YYYY-MM-DD parseable); the window
// check (≥ today-14d, ≤ today+1d) runs in the handler against the resolved
// clock. `occurredAt` defaults to server-now in the handler.
const SERVICE_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Strict object — unknown keys (incl. a forbidden `contactType`) yield a 422
// VALIDATION_FAILED with the offending key path. The path-as-contract rule
// hangs on this — see ticket §Notes.
//
// `summary` is OPTIONAL here with only the max bound. The VR-18 conditional
// (required + ≥10 chars when status='Completed') is enforced in the handler,
// not the schema, so a violation can route to the dedicated
// `SUMMARY_REQUIRED_FOR_COMPLETED` 422 code per API §9.3 mapping — that
// envelope carries `rule: "VR-18"`, `minLength`, `actualLength` and is
// observably distinct from generic `VALIDATION_FAILED`.
export const logCallRequestSchema = z
  .object({
    status: z.enum(LOG_CALL_STATUSES, {
      errorMap: () => ({ message: "status must be a valid picklist value" }),
    }),
    type: z.enum(LOG_CALL_TYPES, {
      errorMap: () => ({ message: "type must be a valid Aftercare-stage value" }),
    }),
    summary: z.string().max(SUMMARY_MAX_LEN, "summary exceeds 2000 chars").optional(),
    serviceDate: z
      .string()
      .regex(SERVICE_DATE_RE, "serviceDate must be YYYY-MM-DD"),
    occurredAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

export type LogCallRequest = z.infer<typeof logCallRequestSchema>;

// VR-18 evaluator — split from the schema so the handler can route the
// failure to the dedicated `SUMMARY_REQUIRED_FOR_COMPLETED` 422 code per
// API §9.3 mapping. Returns `null` when the rule is satisfied (or doesn't
// apply because status is not Completed); otherwise returns the actual
// trimmed length the envelope reports in `details.actualLength`.
export function checkSummaryVr18(request: LogCallRequest): number | null {
  if (request.status !== "Completed") return null;
  const len = (request.summary ?? "").trim().length;
  return len < SUMMARY_MIN_LEN_COMPLETED ? len : null;
}

// Exported so `responses.ts`'s `summaryRequiredForCompletedResponse` can
// surface `details.minLength` against a single source of truth.
export const VR_18_MIN_LEN = SUMMARY_MIN_LEN_COMPLETED;

// ---------------------------------------------------------------------------
// Response shape
// ---------------------------------------------------------------------------

// `priorityRecomputed` mirrors `packages/api/src/barriers/dto.ts` so the SPA
// can read the same engine output regardless of which mutation surfaced the
// recompute (API §7.4.3 calls out the same wire shape as §7.4.8).
export interface PriorityRecomputedFactor {
  readonly key: string;
  readonly name: string;
  readonly valueLabel: string;
  readonly valueNumeric: number;
  readonly weight: string;
  readonly pointsContributed: number;
}

export interface PriorityRecomputed {
  readonly participantId: string;
  readonly score: number | null;
  readonly tier: number | null;
  readonly factors: ReadonlyArray<PriorityRecomputedFactor>;
  readonly previousScore: number | null;
  readonly previousTier: number | null;
}

// Source flag per BR-54 / TR-WRITE-3 / AC-32. Closed enum.
export type LogCallSource = "tool";

// `contactType` is always "phone" for this endpoint — the path is the
// contract. Included on the response so the SPA renders the resulting row
// uniformly with other timeline items (API §7.4.3 v1.3 note).
export type LogCallContactType = "phone";

// E-10 success body per API §7.4.3 + the additive `dataIssues` channel
// (same affordance as `CaseNotesPageBody.dataIssues` on the GET side, per
// `packages/api/src/participants/case-notes-dto.ts:62-67`). `dataIssues`
// carries the schema-gap marker until P1F-03b flips the stub.
export interface LogCallResponseBody {
  readonly caseNoteId: string;
  readonly participantId: string;
  readonly status: LogCallStatus;
  readonly type: LogCallType;
  readonly contactType: LogCallContactType;
  readonly summary: string | null;
  readonly serviceDate: string;
  readonly occurredAt: string;
  readonly loggedAt: string;
  readonly loggedBy: string;
  readonly source: LogCallSource;
  readonly priorityRecomputed: PriorityRecomputed;
  readonly dataIssues: ReadonlyArray<string>;
}

// Schema-gap marker surfaced on every response until `[TBD-v1.3-5]` resolves
// and the real SF write lands (P1F-03b). When the stub flips, this constant
// is dropped from the `dataIssues` array but kept exported for audit-log
// archaeology — a row written under the stub will reference it.
export const SCHEMA_GAP_NO_CASE_NOTE_WRITE_TARGET =
  "schema_gap_no_case_note_write_target";

// Prefix on the synthesized `caseNoteId` while the stub is in place. Real
// Salesforce IDs are 15 or 18 chars and `assertSalesforceId`-shaped; a
// `stub_`-prefixed id fails that guard, so any code that mistakenly tries to
// round-trip a stub id back to SF will throw loud rather than silently 404.
export const STUB_CASE_NOTE_ID_PREFIX = "stub_";
