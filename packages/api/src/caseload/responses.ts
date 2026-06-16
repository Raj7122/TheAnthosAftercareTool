// HTTP responses for the caseload endpoint (E-06). Success + the error
// envelope (API §9.4: `{ code, message, traceId }`); every response carries
// `X-Trace-Id` (API §8.5) and `Cache-Control: no-store` — a caseload body is
// per-specialist data and must never be shared- or CDN-cached (the warm path
// is the server-side P1C-02 cache, not an HTTP cache).

import type { SalesforceError } from "@anthos/integrations";

import type { CaseloadActivityBody } from "./activity-dto.js";
import type { CaseloadBody } from "./dto.js";

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

// 200 — the E-06 caseload body.
export function caseloadSuccessResponse(
  body: CaseloadBody,
  traceId: string,
): Response {
  return jsonResponse(200, body, traceId);
}

// 200 — the E-46 caseload activity body (F-23 Phase B).
export function caseloadActivitySuccessResponse(
  body: CaseloadActivityBody,
  traceId: string,
): Response {
  return jsonResponse(200, body, traceId);
}

// 422 — client supplied a query param or body field this endpoint cannot
// accept (e.g. `?specialistId=` on /caseload/refresh while drill-down is
// deferred). `details.field` is the offending param name. `details.reason` is
// a short snake_case code clients can switch on. No PII echoed back.
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

// 404 — the `?queue=` id is not in the M-CONFIG queue universe. An unknown
// queue is a client error (and the universe drifts as P1C-05 tunes it), so it
// is a 404, not a 500. The queue id is a client-supplied kebab slug, not PII.
export function queueNotFoundResponse(traceId: string): Response {
  return jsonResponse(
    404,
    {
      code: "QUEUE_NOT_FOUND",
      message: "The requested queue does not exist.",
      traceId,
    },
    traceId,
  );
}

// Maps a `SalesforceError` from the bulk-hydration path to an HTTP response.
// A transient upstream fault (timeout / quota / governor limit) is a
// retryable 503; an auth/credential or query fault is a 500 — it is not a
// client-retryable upstream outage, and the cause belongs on the log only.
export function salesforceErrorResponse(
  error: SalesforceError,
  traceId: string,
): Response {
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

// 500 — `INTERNAL_ERROR` (API §7.1.2 / §9.2.2). No PII, no internals in the
// message; the cause is on the structured log, correlated by `traceId`.
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
