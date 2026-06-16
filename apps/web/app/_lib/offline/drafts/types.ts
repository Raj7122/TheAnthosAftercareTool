// P3C-02 — Per-surface form-draft shapes for the tablet PWA surface
// (TR-OFFLINE-7b, BR-69, ADR-05 §6.5a).
//
// Drafts are intentionally NOT the submit DTOs — they accept in-flight,
// partial, and invalid state (Summary < min length, no Type chosen yet, an
// out-of-window service date). The submit DTOs in `useLogCallMutation.ts` /
// `barriers/types.ts` only model the validated wire shape.
//
// Scaffolded surfaces (SMS / email / schedule-visit) ship types + store slots
// here so the consumers (P1H-11 quick-actions, P3A-05 scheduling sheet) get a
// one-line integration when those tickets land. They are NOT wired by P3C-02.

import type { LogCallStatus, LogCallType } from "@anthos/api";

// Dedicated IndexedDB database — kept separate from `anthos-outbox` so the
// session-expiry wipe (TR-OFFLINE-9) can drain drafts independently of the
// queued-action queue. idb-keyval uses one IDB database per
// `createStore(dbName, storeName)` pair.
export const DRAFTS_DB_NAME = "anthos-drafts" as const;
export const DRAFTS_STORE_NAME = "form-drafts" as const;

// Zustand's `persist` middleware writes the serialized slice under a single
// `idb-keyval` key. The constant is the key name, not the slice contents.
export const DRAFTS_PERSIST_KEY = "form-drafts-state" as const;

// Composite key isolating one specialist's draft for one participant from any
// other (specialist, participant) pair. Format: `${specialistId}:${participantId}`.
// Specialist + participant ids are opaque Salesforce record IDs — no PII.
export type DraftScopeKey = string;

export function makeDraftScopeKey(
  specialistId: string,
  participantId: string,
): DraftScopeKey {
  return `${specialistId}:${participantId}`;
}

// F-08 Log-a-Call draft. Field shapes mirror the corresponding submit DTO in
// `apps/web/app/caseload/_lib/useLogCallMutation.ts` but every field is
// optional — a draft for a half-filled sheet is valid storage.
export interface LogCallDraft {
  readonly status?: LogCallStatus;
  readonly type?: LogCallType;
  readonly serviceDate?: string; // YYYY-MM-DD, may be out-of-window
  readonly summary?: string; // may be empty or < SUMMARY_MIN_LEN_COMPLETED
}

// F-06 Create-Barrier draft.
export interface CreateBarrierDraft {
  readonly type?: string;
  readonly description?: string;
}

// --- Scaffolded surfaces (types only — no consumers in P3C-02) ---

// F-11 / P1H-11 SMS compose. The wire DTO is not yet defined; this captures
// the minimum the future consumer will need to round-trip.
export interface SmsComposeDraft {
  readonly body?: string;
  readonly threadId?: string;
}

// F-12 / P1H-11 email compose.
export interface EmailComposeDraft {
  readonly subject?: string;
  readonly body?: string;
}

// F-09 / P3A-05 schedule-visit sheet.
export interface ScheduleVisitDraft {
  readonly visitDate?: string;
  readonly visitType?: string;
  readonly notes?: string;
}
