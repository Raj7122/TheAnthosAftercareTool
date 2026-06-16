// HTTP responses for the visit endpoints (E-13 / E-38 / P3A-03 log) per API
// v1.3 §9.4. Every response carries `X-Trace-Id` and `Cache-Control: no-store`.

import type { SalesforceError } from "@anthos/integrations";

import type {
  LogVisitResponseBody,
  ProposeTimesResponseBody,
  ScheduleVisitResponseBody,
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

export function scheduleVisitSuccessResponse(
  body: ScheduleVisitResponseBody,
  traceId: string,
): Response {
  return jsonResponse(201, body, traceId);
}

export function proposeTimesSuccessResponse(
  body: ProposeTimesResponseBody,
  traceId: string,
): Response {
  return jsonResponse(200, body, traceId);
}

export function logVisitSuccessResponse(
  body: LogVisitResponseBody,
  traceId: string,
): Response {
  return jsonResponse(200, body, traceId);
}

export function validationFailedResponse(
  traceId: string,
  details: { field: string; reason: string },
): Response {
  return jsonResponse(
    422,
    { code: "VALIDATION_FAILED", message: "The request failed validation.", traceId, details },
    traceId,
  );
}

export function notInOwnCaseloadResponse(traceId: string): Response {
  return jsonResponse(
    403,
    { code: "NOT_IN_OWN_CASELOAD", message: "The requested participant is not in your caseload.", traceId },
    traceId,
  );
}

export type RoleScopeReason = "supervisor_scope_unmapped" | "role_not_permitted";

export function roleInsufficientScopeResponse(
  traceId: string,
  reason: RoleScopeReason,
): Response {
  return jsonResponse(
    403,
    { code: "ROLE_INSUFFICIENT_SCOPE", message: "Your role cannot perform this action.", traceId, details: { reason } },
    traceId,
  );
}

export function participantNotFoundResponse(traceId: string): Response {
  return jsonResponse(
    404,
    { code: "RESOURCE_NOT_FOUND", message: "Participant not found.", traceId },
    traceId,
  );
}

// 404 — the visit (Case Note) referenced by :visitId was not found / not a
// Stability Meeting on this participant.
export function visitNotFoundResponse(traceId: string): Response {
  return jsonResponse(
    404,
    { code: "RESOURCE_NOT_FOUND", message: "Visit not found.", traceId },
    traceId,
  );
}

export function salesforceErrorResponse(
  error: SalesforceError,
  traceId: string,
): Response {
  if (error.code === "SF_VALIDATION_FAILED") {
    return jsonResponse(
      422,
      { code: "VALIDATION_FAILED", message: "Salesforce rejected the visit payload.", traceId, details: { field: "body", reason: "salesforce_validation" } },
      traceId,
    );
  }
  if (error.code === "SF_FIELD_FLS_DENIED") {
    return jsonResponse(
      403,
      { code: "ROLE_INSUFFICIENT_SCOPE", message: "Salesforce field-level security denied the write.", traceId },
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
      { code: "SF_UPSTREAM_UNAVAILABLE", message: "Salesforce is temporarily unavailable. Please try again.", traceId },
      traceId,
    );
  }
  return internalErrorResponse(traceId);
}

export function internalErrorResponse(traceId: string): Response {
  return jsonResponse(
    500,
    { code: "INTERNAL_ERROR", message: "Something went wrong. Please try again.", traceId },
    traceId,
  );
}
