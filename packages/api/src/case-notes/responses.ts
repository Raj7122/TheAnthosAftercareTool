// HTTP responses for E-10 (POST /api/v1/participants/:id/calls) per
// API v1.3 §7.4.3 + §9.4 error envelope. Mirrors the shape of
// `packages/api/src/barriers/responses.ts` — every response carries
// `X-Trace-Id` (API §8.5) and `Cache-Control: no-store`.

import type { SalesforceError } from "@anthos/integrations";

import { VR_18_MIN_LEN, type LogCallResponseBody } from "./dto.js";
import type { CreateCaseNoteResponseBody } from "./create-case-note-dto.js";

const JSON_CONTENT_TYPE = "application/json; charset=utf-8";

function jsonResponse(status: number, body: unknown, traceId: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": JSON_CONTENT_TYPE,
      "Cache-Control": "no-store",
      "X-Trace-Id": traceId,
    },
  });
}

export function logCallSuccessResponse(
  body: LogCallResponseBody,
  traceId: string,
): Response {
  return jsonResponse(201, body, traceId);
}

// 201 — POST /api/v1/participants/:id/case-notes (the general Log Case Note
// create; sibling to E-10 `…/calls`). Reuses the same error envelopes below.
export function createCaseNoteSuccessResponse(
  body: CreateCaseNoteResponseBody,
  traceId: string,
): Response {
  return jsonResponse(201, body, traceId);
}

// 422 — VR-16, VR-17 (status/type), VR-19 (max summary length),
// strict-object violation, or other Zod-side rejection. `details.field`
// is the offending JSON pointer.
export function validationFailedResponse(
  traceId: string,
  details: { field: string; reason: string },
): Response {
  return jsonResponse(
    422,
    {
      code: "VALIDATION_FAILED",
      message: "The request failed validation.",
      traceId,
      details,
    },
    traceId,
  );
}

// 422 — VR-18 dedicated envelope per API §9.2.1 + §9.3 + §9.4.1 sample.
// Carries `rule: "VR-18"`, `minLength`, `actualLength` so the SPA can
// render a typed "needs more detail" affordance distinct from generic
// validation failures.
export function summaryRequiredForCompletedResponse(
  traceId: string,
  actualLength: number,
): Response {
  return jsonResponse(
    422,
    {
      code: "SUMMARY_REQUIRED_FOR_COMPLETED",
      message:
        "Summary is required and must be at least 10 characters when Status = Completed.",
      traceId,
      details: {
        field: "summary",
        rule: "VR-18",
        minLength: VR_18_MIN_LEN,
        actualLength,
      },
    },
    traceId,
  );
}

// 403 — SPECIALIST attempting to act on a participant outside their own
// caseload (BR-49 generalized / SEC-AUTHZ-3 per the API §9 catalog).
export function notInOwnCaseloadResponse(traceId: string): Response {
  return jsonResponse(
    403,
    {
      code: "NOT_IN_OWN_CASELOAD",
      message: "The requested participant is not in your caseload.",
      traceId,
    },
    traceId,
  );
}

// 403 — SUPERVISOR (no supervisor→supervised mapping yet; same precedent as
// barriers — see P1C follow-up) AND SYSTEM_ADMIN (permanently out of the
// allowed-roles set) ride this code per API §9.4. The two scenarios are
// observably distinct on `details.reason` so the SPA can tailor guidance.
export type RoleScopeReason =
  | "supervisor_scope_unmapped"
  | "role_not_permitted";

export function roleInsufficientScopeResponse(
  traceId: string,
  reason: RoleScopeReason,
): Response {
  return jsonResponse(
    403,
    {
      code: "ROLE_INSUFFICIENT_SCOPE",
      message: "Your role cannot perform this action.",
      traceId,
      details: { reason },
    },
    traceId,
  );
}

// 404 — the requested Program Enrollment Id was not resolvable. We do NOT
// echo the id back (URL is logged at the platform layer with trace_id).
export function participantNotFoundResponse(traceId: string): Response {
  return jsonResponse(
    404,
    {
      code: "RESOURCE_NOT_FOUND",
      message: "Participant not found.",
      traceId,
    },
    traceId,
  );
}

// 409 — ownership / state changed mid-write per API v1.3 §7.4.3 line 940 +
// §9.2.1 line 2172. `details.sfErrorCode` carries the underlying SF code so
// the SPA / Pattern E queue resolver can render the right affordance;
// `details.suggestedResolution` is the server-derived default per the §9
// error catalog (ENTITY_IS_DELETED → DISCARD per OBQ-3 default;
// INVALID_CROSS_REFERENCE_KEY → ESCALATE_TO_SUPERVISOR). Pattern E proper —
// the offline queue's Review Required state machine — is downstream of this
// response; this handler's job is the wire envelope only (P1F-03b).
//
// `REASSIGN_RETRY` is part of the closed three-resolution enum from
// Pattern E (Review Required) and is preserved on the type
// for forward-compat with future error codes (e.g. `UNABLE_TO_LOCK_ROW`
// retry path); `suggestedResolutionFor` never returns it today.
type SuggestedResolution = "DISCARD" | "REASSIGN_RETRY" | "ESCALATE_TO_SUPERVISOR";

function suggestedResolutionFor(sfErrorCode: string | undefined): SuggestedResolution {
  if (sfErrorCode === "ENTITY_IS_DELETED") return "DISCARD";
  return "ESCALATE_TO_SUPERVISOR";
}

// Sentinel for when an `SF_UPSTREAM_STATE_CHANGED` SalesforceError was
// constructed without the optional `sfErrorCode` 4th arg. The runtime
// adapter (`mapHttpError`) always sets it; this sentinel covers
// hand-constructed instances (tests, or a future caller) so the wire shape
// is observably distinct rather than silently defaulting to a specific SF
// code. `suggestedResolutionFor` falls through to ESCALATE_TO_SUPERVISOR
// for the sentinel, which matches the "unknown ownership/state change"
// posture from API §9 error-catalog OBQ-3 default.
const SF_ERROR_CODE_UNSPECIFIED = "UNSPECIFIED";

export function upstreamStateChangedResponse(
  error: SalesforceError,
  traceId: string,
): Response {
  const sfErrorCode = error.sfErrorCode ?? SF_ERROR_CODE_UNSPECIFIED;
  return jsonResponse(
    409,
    {
      code: "UPSTREAM_STATE_CHANGED",
      message:
        "Salesforce rejected the write because the participant state changed mid-request.",
      traceId,
      details: {
        sfErrorCode,
        suggestedResolution: suggestedResolutionFor(sfErrorCode),
      },
    },
    traceId,
  );
}

// Maps a `SalesforceError` from the M-SF authz lookup (and, post-P1F-03b,
// the write path) to an HTTP response. Validation-shaped DML errors surface
// as 422; FLS / permission denials as 403; ownership/state-changed as 409;
// transient faults as a retryable 503; the rest collapse to 500.
export function salesforceErrorResponse(
  error: SalesforceError,
  traceId: string,
): Response {
  if (error.code === "SF_VALIDATION_FAILED") {
    return jsonResponse(
      422,
      {
        code: "VALIDATION_FAILED",
        message: "Salesforce rejected the Case Note payload.",
        traceId,
        details: { field: "body", reason: "salesforce_validation" },
      },
      traceId,
    );
  }
  if (error.code === "SF_FIELD_FLS_DENIED") {
    return jsonResponse(
      403,
      {
        code: "ROLE_INSUFFICIENT_SCOPE",
        message: "Salesforce field-level security denied the write.",
        traceId,
      },
      traceId,
    );
  }
  if (error.code === "SF_UPSTREAM_STATE_CHANGED") {
    return upstreamStateChangedResponse(error, traceId);
  }
  const transient =
    error.code === "SF_NETWORK_TIMEOUT" ||
    error.code === "SF_QUOTA_EXCEEDED" ||
    error.code === "SF_GOVERNOR_LIMIT";
  if (transient) {
    return jsonResponse(
      503,
      {
        code: "SF_UPSTREAM_UNAVAILABLE",
        message: "Salesforce is temporarily unavailable. Please try again.",
        traceId,
      },
      traceId,
    );
  }
  return internalErrorResponse(traceId);
}

export function internalErrorResponse(traceId: string): Response {
  return jsonResponse(
    500,
    {
      code: "INTERNAL_ERROR",
      message: "Something went wrong. Please try again.",
      traceId,
    },
    traceId,
  );
}
