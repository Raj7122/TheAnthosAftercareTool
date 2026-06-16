// HTTP responses the idempotency middleware emits. Error bodies follow the
// API §9.4 normalized envelope: { code, message, traceId }. Every response
// carries X-Trace-Id (API §8.5).

import type { IdempotencyRecord } from "./store.js";

export type IdempotencyErrorCode =
  | "IDEMPOTENCY_KEY_REQUIRED"
  | "IDEMPOTENCY_KEY_INVALID"
  | "IDEMPOTENCY_IN_FLIGHT"
  | "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD";

interface ErrorSpec {
  readonly status: number;
  readonly message: string;
}

// A Map (not a Record) keeps lookup off variable bracket-access.
const ERROR_SPECS = new Map<IdempotencyErrorCode, ErrorSpec>([
  [
    "IDEMPOTENCY_KEY_REQUIRED",
    { status: 400, message: "An Idempotency-Key header is required for this request." },
  ],
  [
    "IDEMPOTENCY_KEY_INVALID",
    { status: 400, message: "The Idempotency-Key header must be a version-4 UUID." },
  ],
  [
    "IDEMPOTENCY_IN_FLIGHT",
    {
      status: 409,
      message: "A request with this Idempotency-Key is already being processed.",
    },
  ],
  [
    "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD",
    {
      status: 422,
      message: "This Idempotency-Key was already used with a different request body.",
    },
  ],
]);

const JSON_CONTENT_TYPE = "application/json; charset=utf-8";

export function idempotencyErrorResponse(
  code: IdempotencyErrorCode,
  traceId: string,
): Response {
  const spec = ERROR_SPECS.get(code) ?? { status: 400, message: code };
  return new Response(JSON.stringify({ code, message: spec.message, traceId }), {
    status: spec.status,
    headers: {
      "Content-Type": JSON_CONTENT_TYPE,
      "Cache-Control": "no-store",
      "X-Trace-Id": traceId,
    },
  });
}

// Replay of a COMPLETED or FAILED_TERMINAL key — returns the cached body and
// status verbatim (API §8.4). X-Idempotent-Replay lets clients distinguish a
// replay from a fresh response (API §9.4.3).
export function cachedReplayResponse(
  record: IdempotencyRecord,
  traceId: string,
): Response {
  const body =
    record.responseBody === null || record.responseBody === undefined
      ? null
      : JSON.stringify(record.responseBody);
  return new Response(body, {
    status: record.responseStatusCode ?? 200,
    headers: {
      "Content-Type": JSON_CONTENT_TYPE,
      "Cache-Control": "no-store",
      "X-Trace-Id": traceId,
      "X-Idempotent-Replay": "true",
    },
  });
}
