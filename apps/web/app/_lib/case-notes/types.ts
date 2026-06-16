// P1F-05 Pattern A — local case-note record types. Sits outside any single
// page's `_lib/` because two surfaces will consume it: today, the caseload
// page (where F-08 launches from `LogCallSheet`), and tomorrow the F-07
// participant detail page (P1F-08) whose `recentContacts[]` timeline is the
// designed reconciliation surface in the P1F-05 ticket.
//
// The store carries two states per record (Pattern A: "Don't show a green
// saved affordance before the BFF has returned 2xx" — so 'saving' must be
// observably distinct from 'confirmed'). Terminal failure ROLLS BACK
// (record removed) per Pattern A "rollback visibly"; the failure surface is
// the sheet's banner, not a 'failed' record left in the store. Pattern C
// (offline / QUEUED) is out of scope per ticket — when it lands, a third
// 'queued' state slots in here.

import type { LogCallResponseBody, LogCallStatus, LogCallType } from "@anthos/api";

// What the SPA built locally before the round-trip. `optimisticId` is the
// client-only handle the store keys on; it is intentionally NOT the
// `Idempotency-Key` (different lifetimes — the idempotency key reuses across
// retries of the same submit, the optimistic id stays stable across the
// entire optimistic→confirmed lifecycle of one record). `summary` is held
// here because the F-07 timeline renders it; SEC-AUDIT-4 still forbids it
// from `payload_metadata` (server-side audit honors that — see
// `packages/api/src/case-notes/create-call.ts:551-572`).
export interface OptimisticCaseNote {
  readonly optimisticId: string;
  readonly participantId: string;
  readonly callStatus: LogCallStatus;
  readonly type: LogCallType;
  readonly serviceDate: string;
  readonly summary: string | null;
  // Wall-clock at submit-time, in the SPA's clock. The server stamps its own
  // `loggedAt` on the canonical record; this exists so the row can render
  // ordered in the timeline before reconciliation completes.
  readonly optimisticAt: string;
}

// Union of the two visible states a local record can be in. 'failed' is NOT
// a state — terminal failure removes the record (Pattern A rollback). When
// Pattern C lands, add 'queued' here.
//
// `traceId` on the 'confirmed' arm is the BFF's `X-Trace-Id` from the 2xx
// response. Surfaces this so the F-07 timeline can render a "saved · trace
// abc123" debug affordance and so the SPA's correlation matches the
// server-side Pattern B audit row's `trace_id` (the DoD's "matched to
// server-side trace_id" line — satisfied by propagation, not by writing a
// second audit row, since Pattern B's invariant is BEFORE-response and the
// client reconcile happens AFTER-response by definition).
export type LocalCaseNote =
  | { readonly state: "saving"; readonly optimistic: OptimisticCaseNote }
  | {
      readonly state: "confirmed";
      readonly optimistic: OptimisticCaseNote;
      readonly canonical: LogCallResponseBody;
      readonly traceId: string | null;
    };

// Map participantId → ordered list of local records for that participant.
// Order is insertion-order; most-recent-first is the rendering convention
// (the timeline reverses on render). Frozen at the type level — every store
// mutation returns a new map.
export type LocalCaseNotesByParticipant = ReadonlyMap<
  string,
  ReadonlyArray<LocalCaseNote>
>;
