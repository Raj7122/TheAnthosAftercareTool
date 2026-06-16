// HTTP responses for E-11 (POST /api/v1/participants/:id/sms) per API v1.3 §9.4
// error envelope. Mirrors `packages/api/src/case-notes/responses.ts` — every
// response carries `X-Trace-Id` (API §8.5) and `Cache-Control: no-store`.

import type { SalesforceError } from "@anthos/integrations";

import type { SendSmsResponseBody } from "./dto.js";

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

export function sendSmsSuccessResponse(
  body: SendSmsResponseBody,
  traceId: string,
): Response {
  return jsonResponse(201, body, traceId);
}

// 422 — Zod-side / shape rejection. `details.field` is the offending pointer.
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

// 409 — Immutable #4 quiet-hours block. The send was refused because the
// participant's local time is inside the 9 PM–8 AM window and no `scheduledFor`
// was supplied. `details.nextAllowedWindowStart` is the ISO instant the SPA
// offers to schedule the send for; `details.participantTimezone` makes the
// decision legible. No SF write happened; no audit row (pre-mutation rejection).
export function quietHoursBlockedResponse(
  traceId: string,
  details: { nextAllowedWindowStart: string; participantTimezone: string },
): Response {
  return jsonResponse(
    409,
    {
      code: "QUIET_HOURS_BLOCKED",
      message:
        "Outbound SMS is blocked during the participant's quiet hours (9 PM–8 AM local). You can schedule it for the next allowed window.",
      traceId,
      details,
    },
    traceId,
  );
}

// 403 — SMS consent is withdrawn / not on file for this participant (BR-46).
// Mogli opt-out flag is set, so the tool refuses the send.
export function consentWithheldResponse(traceId: string): Response {
  return jsonResponse(
    403,
    {
      code: "SMS_CONSENT_WITHHELD",
      message: "This participant has not consented to SMS (or has opted out).",
      traceId,
      details: { reason: "mogli_opt_out" },
    },
    traceId,
  );
}

// 422 — the participant has no phone number on file, so there is no recipient.
export function noPhoneOnFileResponse(traceId: string): Response {
  return jsonResponse(
    422,
    {
      code: "NO_PHONE_ON_FILE",
      message: "This participant has no phone number on file.",
      traceId,
      details: { field: "participant", reason: "no_phone_on_file" },
    },
    traceId,
  );
}

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

export type RoleScopeReason = "supervisor_scope_unmapped" | "role_not_permitted";

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

// Maps a `SalesforceError` (authz lookup or the Mogli SMS insert) to an HTTP
// response. Same taxonomy as the Log-a-Call path: validation → 422, FLS → 403,
// transient → 503, the rest → 500.
export function salesforceErrorResponse(
  error: SalesforceError,
  traceId: string,
): Response {
  if (error.code === "SF_VALIDATION_FAILED") {
    return jsonResponse(
      422,
      {
        code: "VALIDATION_FAILED",
        message: "Salesforce rejected the SMS payload.",
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
