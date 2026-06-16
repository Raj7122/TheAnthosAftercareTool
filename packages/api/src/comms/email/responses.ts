// HTTP responses for E-12 (POST /api/v1/participants/:id/emails) per API v1.3
// §9.4 error envelope. Mirrors the SMS / Log-a-Call response helpers — every
// response carries `X-Trace-Id` and `Cache-Control: no-store`.

import type { SalesforceError } from "@anthos/integrations";

import type { SendEmailResponseBody } from "./dto.js";

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

// 202 Accepted — the Flow created the Activity; Salesforce performs the send.
export function sendEmailAcceptedResponse(
  body: SendEmailResponseBody,
  traceId: string,
): Response {
  return jsonResponse(202, body, traceId);
}

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

// 403 — the participant has opted out of email (Contact.HasOptedOutOfEmail).
export function emailConsentWithheldResponse(traceId: string): Response {
  return jsonResponse(
    403,
    {
      code: "EMAIL_CONSENT_WITHHELD",
      message: "This participant has opted out of email.",
      traceId,
      details: { reason: "has_opted_out_of_email" },
    },
    traceId,
  );
}

// 422 — no email address on file for the participant.
export function noEmailOnFileResponse(traceId: string): Response {
  return jsonResponse(
    422,
    {
      code: "NO_EMAIL_ON_FILE",
      message: "This participant has no email address on file.",
      traceId,
      details: { field: "participant", reason: "no_email_on_file" },
    },
    traceId,
  );
}

// 503 — the tool-owned email Flow is not configured/deployed yet
// (EMAIL_FLOW_API_NAME unset). The endpoint exists and is correct; it lights up
// when the autolaunched Flow is deployed and its API name configured. Distinct,
// non-destructive signal so the SPA can disable the affordance gracefully.
export function emailNotConfiguredResponse(traceId: string): Response {
  return jsonResponse(
    503,
    {
      code: "EMAIL_NOT_CONFIGURED",
      message:
        "Email sending is not yet enabled (the tool-owned Salesforce Flow is not deployed).",
      traceId,
      details: { reason: "email_flow_not_configured" },
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
    { code: "RESOURCE_NOT_FOUND", message: "Participant not found.", traceId },
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
      {
        code: "VALIDATION_FAILED",
        message: "Salesforce rejected the email payload.",
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
        message: "Salesforce field-level security denied the operation.",
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
    { code: "INTERNAL_ERROR", message: "Something went wrong. Please try again.", traceId },
    traceId,
  );
}
