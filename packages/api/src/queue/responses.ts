// HTTP responses for the queue endpoints (E-17 GET /queue/pending — P3C-05,
// E-18 POST /queue/sync — P3C-06, E-19 POST /queue/:id/resolve — P3C-07).
// Success + the error envelope (API §9.4: `{ code, message, traceId }`).
// Every response carries `X-Trace-Id` (API §8.5) and `Cache-Control: no-store`
// — a queue body is per-specialist data and must never be shared- or
// CDN-cached.

import type { QueueResolveBody, QueuePendingBody, QueueSyncBody } from "./dto.js";

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

// 200 — the §7.5.1 queue pending body.
export function queuePendingSuccessResponse(
  body: QueuePendingBody,
  traceId: string,
): Response {
  return jsonResponse(200, body, traceId);
}

// 200 — the §7.5.2 queue sync body.
export function queueSyncSuccessResponse(
  body: QueueSyncBody,
  traceId: string,
): Response {
  return jsonResponse(200, body, traceId);
}

// 200 / 201 — §7.5.3 queue resolve body. DISCARD + REASSIGN_RETRY return 200;
// ESCALATE_TO_SUPERVISOR returns 201 (the escalation row is the new resource
// surfaced by the F-17 supervisor surface). Status code is caller-supplied so
// the handler keeps the §7.5.3 contract explicit at the call site.
export function queueResolveSuccessResponse(
  body: QueueResolveBody,
  traceId: string,
  statusCode: 200 | 201,
): Response {
  return jsonResponse(statusCode, body, traceId);
}

// 400 — VALIDATION_FAILED with the offending field path on `details.field`.
// Mirrors `validationFailedResponse` in `barriers/responses.ts`; reproduced
// here so the queue module stays independent of the barriers helper set.
export function queueResolveValidationErrorResponse(
  traceId: string,
  details: { field: string; reason: string },
): Response {
  return jsonResponse(
    400,
    {
      code: "VALIDATION_FAILED",
      message: "The request body is invalid.",
      traceId,
      details,
    },
    traceId,
  );
}

// 404 — QUEUE_ITEM_NOT_FOUND. Returned for BOTH (a) an unknown queue id and
// (b) a known id owned by another specialist. The two cases collapse into
// one response so a specialist cannot infer the existence of another's
// queue rows by probing ids — matches the "server-resolved scope, never
// query param" posture in get-queue-pending.ts:106.
export function queueItemNotFoundResponse(traceId: string): Response {
  return jsonResponse(
    404,
    {
      code: "QUEUE_ITEM_NOT_FOUND",
      message: "Queue item not found.",
      traceId,
    },
    traceId,
  );
}

// 409 — QUEUE_ITEM_NOT_RESOLVABLE. The item exists and belongs to the caller
// but its status is not one of the two Review Required variants
// (`review_required_reassigned` / `review_required_terminated`). Pattern E
// resolutions only apply to those two states — `pending_sync`, `in_flight`,
// `completed`, `discarded`, `failed_max_retries` are all non-resolvable here.
export function queueItemNotResolvableResponse(
  traceId: string,
  currentStatus: string,
): Response {
  return jsonResponse(
    409,
    {
      code: "QUEUE_ITEM_NOT_RESOLVABLE",
      message:
        "This queue item is not in a resolvable state. Only items awaiting Review Required disposition can be resolved.",
      traceId,
      details: { currentStatus },
    },
    traceId,
  );
}

// 403 — Specialist-only per API §8.3.2 L1994. Supervisor / VP / SYSTEM_ADMIN
// share the canonical `ROLE_INSUFFICIENT_SCOPE` code; `details.reason`
// distinguishes them so the SPA can tailor guidance.
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
