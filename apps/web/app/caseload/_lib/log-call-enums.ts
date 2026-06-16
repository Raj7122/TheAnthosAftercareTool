// F-08 Log-a-Call picklist option arrays. Maps the wire tokens published by
// `packages/api/src/case-notes/dto.ts` to the labels rendered in the
// `<select>` controls of `LogCallSheet.tsx`.
//
// The Status `SBOP` wire token displays as "Seen by Other Provider" — that's
// BR-21's deployed Path B name (FS v1.12 line 818 + dto.ts:33-41). The
// wire-vs-display split lives here so the sheet never has to know about it.
//
// `Type` wire values preserve the spec's exact (mixed-case) spellings
// because the server's `.strict()` Zod schema rejects unknown keys; UI labels
// can use Title Case for readability without affecting the request body.
//
// Wire token arrays are intentionally re-declared here as runtime constants
// (rather than imported as values from `@anthos/api`) because a value
// import of the `@anthos/api` barrel pulls the whole server graph — incl.
// `packages/persistence` → `pg` → Node-only `net`/`tls`/`dns` — into the
// Next.js client bundle, breaking the webpack build. Only `import type` is
// safe across that seam. The companion test
// (`apps/web/test/caseload/log-call-enums.test.ts`) does a parity check
// against the wire enum imported from `@anthos/api` so drift is caught
// in CI (the test runs in Node, not webpack, so the value import is fine
// there).

import type { LogCallStatus, LogCallType } from "@anthos/api";

const LOG_CALL_STATUSES_LOCAL: readonly LogCallStatus[] = [
  "Completed",
  "Attempted",
  "Scheduled",
  "Rescheduled",
  "Canceled",
  "SBOP",
];

const LOG_CALL_TYPES_LOCAL: readonly LogCallType[] = [
  "Check In",
  "Stability Meeting",
  "Resource referral",
  "Crisis support",
  "Lease renewal",
  "Voucher recert support",
  "Documentation request",
];

export interface PicklistOption<T extends string> {
  readonly value: T;
  readonly label: string;
}

// Order matches the F-08 Inputs prose (FS v1.12 line 818) with `Attempted`
// surfaced first because it is the default the sheet opens with (the most
// common outcome of a one-off field call, per the ticket).
export const LOG_CALL_STATUS_OPTIONS: ReadonlyArray<PicklistOption<LogCallStatus>> = [
  { value: "Attempted", label: "Attempted (no contact)" },
  { value: "Completed", label: "Completed (connected)" },
  { value: "Scheduled", label: "Scheduled" },
  { value: "Rescheduled", label: "Rescheduled" },
  { value: "Canceled", label: "Canceled" },
  { value: "SBOP", label: "Seen by Other Provider" },
];

export const LOG_CALL_TYPE_OPTIONS: ReadonlyArray<PicklistOption<LogCallType>> = [
  { value: "Check In", label: "Check In" },
  { value: "Stability Meeting", label: "Stability Meeting" },
  { value: "Resource referral", label: "Resource Referral" },
  { value: "Crisis support", label: "Crisis Support" },
  { value: "Lease renewal", label: "Lease Renewal" },
  { value: "Voucher recert support", label: "Voucher Recert Support" },
  { value: "Documentation request", label: "Documentation Request" },
];

export const LOG_CALL_DEFAULT_STATUS: LogCallStatus = "Attempted";
export const LOG_CALL_DEFAULT_TYPE: LogCallType = "Check In";

// VR-18 minimum summary length when Status=Completed (impl-plan shorthand
// "BR-29" — note FS v1.12 BR-29 at line 646 is an F-05 cycle rule, NOT this
// constraint; the impl plan / ticket use "BR-29" as informal shorthand for
// the VR-18 Connected-branch guard). Mirrors `packages/api/src/case-notes/
// dto.ts` so the client guard and the server validator agree.
export const SUMMARY_MIN_LEN_COMPLETED = 10;

// BR-45 / VR-19 cap.
export const SUMMARY_MAX_LEN = 2000;

// Re-export the locally-declared wire arrays under the canonical names so
// the test can assert parity against `@anthos/api` and any future consumer
// reads the same source the option arrays were built from.
export {
  LOG_CALL_STATUSES_LOCAL as LOG_CALL_STATUSES,
  LOG_CALL_TYPES_LOCAL as LOG_CALL_TYPES,
};
export type { LogCallStatus, LogCallType };
