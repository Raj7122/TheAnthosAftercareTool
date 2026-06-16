// HTTP response for a CSRF Origin-mismatch rejection (API §8.6 + §9.2.1). The
// body follows the API §7.1.2 / §9.4 normalized envelope { code, message,
// traceId } — and deliberately carries NO `details`: the rejected `Origin` and
// any session / participant identifier are never echoed back to the caller
// (pii-firewall; SEC-AUTH-4). Carries `Cache-Control: no-store` and
// `X-Trace-Id` (API §8.5), mirroring `session/responses.ts`.

const JSON_CONTENT_TYPE = "application/json; charset=utf-8";

// API §9.2.1 error catalog code for an Origin-header rejection.
export const CSRF_ORIGIN_MISMATCH = "CSRF_ORIGIN_MISMATCH";

// Build the 403 `CSRF_ORIGIN_MISMATCH` response.
export function csrfOriginMismatchResponse(traceId: string): Response {
  return new Response(
    JSON.stringify({
      code: CSRF_ORIGIN_MISMATCH,
      message: "Request origin not permitted.",
      traceId,
    }),
    {
      status: 403,
      headers: {
        "Content-Type": JSON_CONTENT_TYPE,
        // A CSRF rejection must never be cached or shared.
        "Cache-Control": "no-store",
        "X-Trace-Id": traceId,
      },
    },
  );
}
