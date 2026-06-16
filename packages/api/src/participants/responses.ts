// HTTP responses for the participant-scoped reads: E-08 (`GET
// /api/v1/participants/:id`) and E-09 (`GET /api/v1/participants/:id/case-notes`).
// Success + the canonical `{ code, message, traceId }` envelope (API §9.4).
// Every response carries `X-Trace-Id` (API §8.5) and `Cache-Control: no-store`
// — participant data is per-caller PII-bearing and must never be shared- or
// CDN-cached.

import type { SalesforceError } from "@anthos/integrations";

import type { CaseNotesPageBody } from "./case-notes-dto.js";
import type { ParticipantDetailBody } from "./dto.js";

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

// 200 — the E-08 detail body.
export function participantDetailSuccessResponse(
  body: ParticipantDetailBody,
  traceId: string,
): Response {
  return jsonResponse(200, body, traceId);
}

// 200 — the E-09 paginated case-notes page (cursor envelope per API §7.1.3).
// `summary` content on each item is the participant's PII; the wire body
// carries it, but it MUST NOT appear in audit `payload_metadata` or any log
// line written off the back of this response (caller responsibility).
export function caseNotesSuccessResponse(
  body: CaseNotesPageBody,
  traceId: string,
): Response {
  return jsonResponse(200, body, traceId);
}

// 400 — pagination cursor signature/format invalid, tampered, or scoped to a
// different user (§9.2.1 / §10.1). Body intentionally minimal — never echoes
// the cursor token (could be used to probe the signing key).
export function cursorInvalidResponse(traceId: string): Response {
  return jsonResponse(
    400,
    {
      code: "CURSOR_INVALID",
      message: "Pagination cursor is invalid. Please restart pagination.",
      traceId,
    },
    traceId,
  );
}

// 400 — cursor age exceeds the §10.1 TTL (≥7d for case-note history).
export function cursorExpiredResponse(traceId: string): Response {
  return jsonResponse(
    400,
    {
      code: "CURSOR_EXPIRED",
      message: "Pagination cursor has expired. Please restart pagination.",
      traceId,
    },
    traceId,
  );
}

// 400 — `INVALID_QUERY_PARAM` per §9.2.1. `details.param` names the offending
// query parameter (e.g., `contactType` for an off-enum value, `limit` for a
// non-integer or out-of-range). Body never echoes the offending value — log
// it server-side with the trace id if a debug breadcrumb is needed.
export function invalidQueryParamResponse(
  traceId: string,
  details: { param: string },
): Response {
  return jsonResponse(
    400,
    {
      code: "INVALID_QUERY_PARAM",
      message: "A query parameter is missing or invalid.",
      traceId,
      details,
    },
    traceId,
  );
}

// 422 — invalid Salesforce Id shape on the path param. `details.field` follows
// the §9.4 convention.
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

// 403 — SPECIALIST requesting a participant outside their own caseload
// (VR-15). Mirrors the create-Barrier response so the SPA can share handling.
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

// 403 — SUPERVISOR (no supervisor→supervised mapping yet — same stub posture as
// the create-Barrier handler) and SYSTEM_ADMIN (permanently outside the F-07
// allowed-roles set) share this code; `details.reason` distinguishes them so
// the SPA can tailor guidance.
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

// 404 — the requested Program Enrollment Id did not resolve to a row. The Id
// is not echoed in the body (logged at the platform layer alongside trace_id).
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

// Maps a `SalesforceError` from the identity-hydration or scoring path to an
// HTTP response. Mirrors the caseload mapping: transient → 503 retryable, FLS
// → 403, the rest → 500.
export function salesforceErrorResponse(
  error: SalesforceError,
  traceId: string,
): Response {
  if (error.code === "SF_FIELD_FLS_DENIED") {
    return jsonResponse(
      403,
      {
        code: "ROLE_INSUFFICIENT_SCOPE",
        message: "Salesforce field-level security denied the read.",
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
