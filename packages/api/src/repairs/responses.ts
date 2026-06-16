// HTTP responses for POST /api/v1/participants/:id/repairs. Success + the
// canonical `{ code, message, traceId }` error envelope (API §9.4). Every
// response carries `X-Trace-Id` (API §8.5) and `Cache-Control: no-store` — a
// mutation response must never be cached. Mirrors the barrier response catalog;
// adds REPAIR_UNIT_ENGAGEMENT_MISSING for the no-Unit-Engagement fallback so a
// participant with no Unit Engagement gets a surfaced, non-silent 409 rather
// than a silent failure (we don't catch errors silently).

import type { SalesforceError } from "@anthos/integrations";

import type { CreateRepairResponseBody } from "./dto.js";

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

export function createRepairSuccessResponse(
  body: CreateRepairResponseBody,
  traceId: string,
): Response {
  return jsonResponse(201, body, traceId);
}

// 422 — missing/empty `note`, strict-object violation (unknown keys), or other
// Zod-side rejection. `details.field` is the offending key.
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
// caseload (BR-35 / SEC-AUTHZ-3).
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

export type RoleScopeReason =
  | "supervisor_scope_unmapped"
  | "role_not_permitted";

// 403 — SUPERVISOR (no supervisor→supervised mapping yet) and SYSTEM_ADMIN
// (permanently out of BR-35 allowed roles) ride the canonical code; the
// distinguishing detail is on `details.reason`.
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

// 404 — the requested Program Enrollment Id was not resolvable.
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

// 409 — the participant has no Unit Engagement (`Unit_Rental__c`) to attach the
// repair to. `Repair__c` has no direct FK to the participant; the link is
// `Repair__c.Unit_Rental__c` → `Unit_Rental__c.Program_Enrollment__c`. Without a
// Unit Engagement there is no valid parent, so we cannot write the repair. This
// is surfaced inline (not swallowed) so the specialist understands why.
export function noUnitEngagementResponse(traceId: string): Response {
  return jsonResponse(
    409,
    {
      code: "REPAIR_UNIT_ENGAGEMENT_MISSING",
      message:
        "This participant has no Unit Engagement, so a repair cannot be attached.",
      traceId,
      details: { reason: "no_unit_rental" },
    },
    traceId,
  );
}

// Maps a `SalesforceError` from the M-SF path to an HTTP response.
export function salesforceErrorResponse(
  error: SalesforceError,
  traceId: string,
): Response {
  if (error.code === "SF_VALIDATION_FAILED") {
    return jsonResponse(
      422,
      {
        code: "VALIDATION_FAILED",
        message: "Salesforce rejected the repair payload.",
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
