// HTTP responses the session middleware emits on a 401 short-circuit. Error
// bodies follow the API §9.4 normalized envelope: { code, message, traceId,
// details? }. Every response carries X-Trace-Id (API §8.5).

export type SessionErrorCode = "AUTH_SESSION_INVALID" | "AUTH_SESSION_EXPIRED";

// `AUTH_SESSION_EXPIRED` carries the instant the session lapsed (API §9.2.1).
export interface SessionErrorDetails {
  readonly expiredAt: string;
}

interface ErrorSpec {
  readonly status: number;
  readonly message: string;
}

const ERROR_SPECS = new Map<SessionErrorCode, ErrorSpec>([
  [
    "AUTH_SESSION_INVALID",
    {
      status: 401,
      message: "No valid session. Sign in to continue.",
    },
  ],
  [
    "AUTH_SESSION_EXPIRED",
    {
      status: 401,
      message: "Your session has expired. Sign in to continue.",
    },
  ],
]);

const JSON_CONTENT_TYPE = "application/json; charset=utf-8";

export function sessionErrorResponse(
  code: SessionErrorCode,
  traceId: string,
  details?: SessionErrorDetails,
): Response {
  const spec = ERROR_SPECS.get(code) ?? { status: 401, message: code };
  const body =
    details === undefined
      ? { code, message: spec.message, traceId }
      : { code, message: spec.message, traceId, details };
  return new Response(JSON.stringify(body), {
    status: spec.status,
    headers: {
      "Content-Type": JSON_CONTENT_TYPE,
      // An auth-rejection response must never be cached or shared.
      "Cache-Control": "no-store",
      "X-Trace-Id": traceId,
    },
  });
}
