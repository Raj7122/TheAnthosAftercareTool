// HTTP responses for E-15 (POST /api/v1/participants/:id/barriers) and E-16
// (PATCH /api/v1/participants/:id/barriers/:barrierId action=close). Success +
// the canonical `{ code, message, traceId }` error envelope (API §9.4). Every
// response carries `X-Trace-Id` (API §8.5) and `Cache-Control: no-store` — a
// mutation response must never be cached.

import type { SalesforceError } from "@anthos/integrations";

import type {
  CloseBarrierResponseBody,
  CreateBarrierResponseBody,
} from "./dto.js";

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

export function createBarrierSuccessResponse(
  body: CreateBarrierResponseBody,
  traceId: string,
): Response {
  return jsonResponse(201, body, traceId);
}

// E-16 success — 200 (PATCH update, not 201 create).
export function closeBarrierSuccessResponse(
  body: CloseBarrierResponseBody,
  traceId: string,
): Response {
  return jsonResponse(200, body, traceId);
}

// 422 — VR-12 (unknown Type), VR-14 (missing Type), strict-object violation,
// or other Zod-side rejection. `details.field` is the offending JSON pointer.
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

// 403 — SPECIALIST attempting to act on a participant outside their own
// caseload (BR-35 / SEC-AUTHZ-3 per the API §9 catalog).
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

// 403 — both SUPERVISOR (no supervisor→supervised mapping yet, see P1C
// follow-up; will close when the mapping lands) AND SYSTEM_ADMIN (permanently
// out of BR-35 allowed roles) ride this code per API §9.4's catalog. The two
// scenarios are observably distinct on `details.reason` so the SPA can tailor
// guidance: `supervisor_scope_unmapped` is "your role will be permitted once a
// future ticket ships"; `role_not_permitted` is "your role is never permitted
// for this action." The wire `code` stays canonical so the catalog is stable.
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

// 404 — the requested Program Enrollment Id was not resolvable. We do NOT echo
// the id back (URL is logged at the platform layer with the trace_id).
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

// Maps a `SalesforceError` from the M-SF write path to an HTTP response.
// Validation-shaped DML errors (SF_VALIDATION_FAILED) bubble out as a 422 so a
// client distinguishes "your Type was wrong" from "Salesforce is down"; FLS /
// permission denials surface as 403; transient faults as a retryable 503; the
// rest collapse to 500.
export function salesforceErrorResponse(
  error: SalesforceError,
  traceId: string,
): Response {
  if (error.code === "SF_VALIDATION_FAILED") {
    return jsonResponse(
      422,
      {
        code: "VALIDATION_FAILED",
        message: "Salesforce rejected the Barrier payload.",
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
