// HTTP error responses for the auth cluster (GET /api/v1/auth/login E-01,
// GET /api/v1/auth/callback E-02). JSON error bodies follow the API §7.1.2
// normalized envelope { code, message, traceId, details? }. Every response
// carries `Cache-Control: no-store` (API §14.4 — the auth endpoints are never
// cached) and `X-Trace-Id` (API §8.5). Mirrors `session/responses.ts`.

export type AuthErrorCode =
  | "INVALID_QUERY_PARAM"
  | "AUTH_CONFIG_ERROR"
  | "SF_UPSTREAM_UNAVAILABLE"
  | "INTERNAL_ERROR";

// `INVALID_QUERY_PARAM` carries the offending param NAME (API §9.2.1) — the
// rejected VALUE is never echoed; it is attacker-controlled.
export interface InvalidQueryParamDetails {
  readonly param: string;
}

interface ErrorSpec {
  readonly status: number;
  readonly message: string;
}

const ERROR_SPECS = new Map<AuthErrorCode, ErrorSpec>([
  ["INVALID_QUERY_PARAM", { status: 400, message: "A query parameter was missing or malformed." }],
  [
    // 500 — a missing/misconfigured env var; the var name is logged, never
    // surfaced here. The message is generic and safe to display.
    "AUTH_CONFIG_ERROR",
    {
      status: 500,
      message: "Sign-in is temporarily unavailable. Please try again.",
    },
  ],
  [
    // 503 — Salesforce's token endpoint is unreachable during a refresh
    // (E-03). Transient: the caller may retry (API §9.2.2). The session is
    // NOT invalidated — distinct from the 401 "not refreshable" path.
    "SF_UPSTREAM_UNAVAILABLE",
    {
      status: 503,
      message: "Salesforce is temporarily unavailable. Please try again.",
    },
  ],
  [
    // 500 — an unhandled exception inside a handler (API §9.2.2 catalog row).
    // Distinct from `AUTH_CONFIG_ERROR`: that names operator misconfiguration,
    // this names a runtime fault (e.g. a DB failure). The message is generic
    // and safe to display (API §3086 — never echo raw `message` for this
    // class); the real cause rides the structured log under `traceId`.
    "INTERNAL_ERROR",
    {
      status: 500,
      message: "Something went wrong. Please try again.",
    },
  ],
]);

const JSON_CONTENT_TYPE = "application/json; charset=utf-8";

// Build an API §7.1.2 error response for the auth cluster.
export function authErrorResponse(
  code: AuthErrorCode,
  traceId: string,
  details?: InvalidQueryParamDetails,
): Response {
  const spec = ERROR_SPECS.get(code) ?? { status: 500, message: code };
  const body =
    details === undefined
      ? { code, message: spec.message, traceId }
      : { code, message: spec.message, traceId, details };
  return new Response(JSON.stringify(body), {
    status: spec.status,
    headers: {
      "Content-Type": JSON_CONTENT_TYPE,
      "Cache-Control": "no-store",
      "X-Trace-Id": traceId,
    },
  });
}

// API §7.2.2: a GET /auth/callback failure that arrived from a plausible OAuth
// redirect returns a 302 to the SPA, carrying a short error CODE in the query
// string — never PII, never token material. The SPA reads `?authError` and
// renders the FS-01 / FS-02 user-facing message. Malformed direct-hit requests
// (missing `code`/`state`, config error) use the JSON `authErrorResponse`
// envelope instead — they did not come from a real Salesforce redirect.
export type AuthCallbackErrorCode =
  | "oauth_denied" // user cancelled at Salesforce, or SF returned `?error=`
  | "oauth_failed" // state mismatch, cookie problem, invalid_grant, scope mismatch
  | "not_provisioned" // FS-02 — the user holds none of the tool's permission sets
  | "sf_unavailable"; // Salesforce network / timeout during exchange or role query

// The SPA landing path a callback failure redirects to. The SPA reads
// `?authError` and renders the matching message; that page is a later SPA
// ticket — P1B-02 only emits the redirect.
const CALLBACK_ERROR_LANDING = "/";

// Build the API §7.2.2 callback-failure redirect. `code` is a controlled enum
// — the only thing placed in the URL — so no `code`, token, or SF id can leak
// into a query string, a browser history entry, or a referer header.
export function authRedirectFailure(
  code: AuthCallbackErrorCode,
  traceId: string,
): Response {
  return new Response(null, {
    status: 302,
    headers: {
      Location: `${CALLBACK_ERROR_LANDING}?authError=${encodeURIComponent(code)}`,
      "Cache-Control": "no-store",
      "X-Trace-Id": traceId,
    },
  });
}
