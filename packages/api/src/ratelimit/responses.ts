// HTTP response for an application-level rate-limit rejection. The body follows
// the API §7.1.2 / §9.4 normalized envelope { code, message, traceId, details };
// for `RATE_LIMITED` the §9.2.1 catalog prescribes `details: { retryAfterSeconds,
// limit }`. The response carries `Retry-After` (API §11.3 / RFC 7231),
// `Cache-Control: no-store`, and `X-Trace-Id` (API §8.5).

const JSON_CONTENT_TYPE = "application/json; charset=utf-8";

export interface RateLimitDetails {
  // The window the client should wait before retrying.
  readonly retryAfterSeconds: number;
  // The budget that was exceeded — e.g. 1 for "1 per 5s".
  readonly limit: number;
}

// Build the 429 `RATE_LIMITED` response (API §9.2.1).
export function rateLimitErrorResponse(
  traceId: string,
  details: RateLimitDetails,
): Response {
  return new Response(
    JSON.stringify({
      code: "RATE_LIMITED",
      message: "Too many requests. Please wait a moment and try again.",
      traceId,
      details,
    }),
    {
      status: 429,
      headers: {
        "Content-Type": JSON_CONTENT_TYPE,
        "Cache-Control": "no-store",
        "X-Trace-Id": traceId,
        "Retry-After": String(Math.max(1, Math.ceil(details.retryAfterSeconds))),
      },
    },
  );
}
