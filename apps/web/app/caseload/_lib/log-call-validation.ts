// Pure validation + error-mapping helpers for the F-08 Log-a-Call sheet.
// Extracted from `LogCallSheet.tsx` so the Connected (Status='Completed' →
// summary required, ≥10 trim chars per VR-18) and Failed (other statuses →
// summary optional) branches plus the SUMMARY_REQUIRED_FOR_COMPLETED
// envelope reconstruction can be unit-tested without bringing jsdom +
// Testing Library into apps/web (the existing test posture for caseload
// sheets is pure-logic-only — see CreateBarrierSheet/CloseBarrierConfirm:
// neither has a `.test.tsx` today).
//
// The ticket and impl-plan §3 row P1F-04 refer to these branches as
// "BR-29 (Connected → summary required)" and "BR-30 (Failed → summary
// optional)", but FS v1.12 BR-29 and BR-30 are F-05 cycle rules ("Overdue"
// and "Scheduled" stability-visit statuses, lines 646-647). The FS
// authority for the summary-required split is VR-18 (line 840). The
// ticket-style shorthand is preserved in test descriptions for DoD
// traceability; the canonical FS citation is VR-18.

import type { LogCallStatus, LogCallType } from "@anthos/api";

import { SUMMARY_MIN_LEN_COMPLETED } from "./log-call-enums";
import type { MutationFailure } from "./send-mutation";

export interface FieldErrors {
  status?: string;
  type?: string;
  serviceDate?: string;
  summary?: string;
}

export interface ServiceDateBounds {
  readonly min: string;
  readonly max: string;
}

export interface ValidateArgs {
  readonly status: LogCallStatus;
  readonly type: LogCallType;
  readonly serviceDate: string;
  readonly summary: string;
  readonly dateBounds: ServiceDateBounds;
}

export function validate(args: ValidateArgs): FieldErrors {
  const errors: FieldErrors = {};
  if (args.serviceDate.length === 0) {
    errors.serviceDate = "Service date is required.";
  } else if (
    args.serviceDate < args.dateBounds.min ||
    args.serviceDate > args.dateBounds.max
  ) {
    errors.serviceDate = "Service date must be today or within the last 14 days.";
  }
  if (args.status === "Completed") {
    const trimLen = args.summary.trim().length;
    if (trimLen < SUMMARY_MIN_LEN_COMPLETED) {
      errors.summary = `Summary must be at least ${SUMMARY_MIN_LEN_COMPLETED} characters when Status = Completed. (${trimLen}/${SUMMARY_MIN_LEN_COMPLETED})`;
    }
  }
  return errors;
}

export function hasAnyError(errors: FieldErrors): boolean {
  return (
    errors.status !== undefined ||
    errors.type !== undefined ||
    errors.serviceDate !== undefined ||
    errors.summary !== undefined
  );
}

export interface MappedFailure {
  // Field-scoped error (rendered inline on that field). Mutually exclusive
  // with `bannerError` — a server failure either names a field or doesn't.
  readonly fieldErrors: FieldErrors | null;
  readonly bannerError: MutationFailure | null;
}

// Maps a server `MutationFailure` to the closest field (when the envelope
// names one) or to the banner. The dedicated VR-18 envelope
// `SUMMARY_REQUIRED_FOR_COMPLETED` carries `actualLength`/`minLength`, so we
// reconstruct the same `(n/min)` counter the client guard would have shown,
// keeping the inline message stable whether the rejection came from us or
// the server.
export function mapFailureToFields(failure: MutationFailure): MappedFailure {
  if (failure.code === "SUMMARY_REQUIRED_FOR_COMPLETED") {
    const min = failure.minLength ?? SUMMARY_MIN_LEN_COMPLETED;
    const actual = failure.actualLength ?? 0;
    return {
      fieldErrors: {
        summary: `Summary must be at least ${min} characters when Status = Completed. (${actual}/${min})`,
      },
      bannerError: null,
    };
  }
  if (failure.code === "VALIDATION_FAILED" && failure.field !== null) {
    if (
      failure.field === "summary" ||
      failure.field === "status" ||
      failure.field === "type" ||
      failure.field === "serviceDate"
    ) {
      return {
        fieldErrors: { [failure.field]: failure.message },
        bannerError: null,
      };
    }
  }
  return { fieldErrors: null, bannerError: failure };
}

// Per FS v1.12 VR-17: service date must be ≥ today-14d AND ≤ today. The
// server (API §7.4.3) is more permissive (≤ today+1d for Scheduled), but the
// FS rule wins per spec precedence (FS > API) — and the client
// being the stricter bound here is harmless: a Scheduled-tomorrow log can
// always be entered with today's date and the server adjusts via
// `occurredAt` semantics.
export function computeServiceDateBounds(now: Date): ServiceDateBounds {
  const today = formatLocalYyyyMmDd(now);
  const minDate = new Date(now);
  minDate.setDate(minDate.getDate() - 14);
  return { min: formatLocalYyyyMmDd(minDate), max: today };
}

export function formatLocalYyyyMmDd(d: Date): string {
  const yyyy = d.getFullYear().toString().padStart(4, "0");
  const mm = (d.getMonth() + 1).toString().padStart(2, "0");
  const dd = d.getDate().toString().padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}
