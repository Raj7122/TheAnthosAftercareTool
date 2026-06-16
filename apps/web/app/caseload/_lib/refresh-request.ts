// HTTP client for `POST /api/v1/caseload/refresh` (E-07). The refresh
// endpoint takes no body but requires an `Idempotency-Key` (Pattern D), so
// the existing `sendMutation` envelope shape isn't a clean fit — it
// JSON-stringifies a body, and on 429 it discards the `Retry-After` header
// (which the UI's rate-limit countdown needs).
//
// Keeps the request-shaping + envelope parsing testable without React.

import type { CaseloadBody } from "@anthos/api";

import type { FetchLike, MutationFailure } from "./send-mutation";

export type RefreshOutcome =
  | { readonly kind: "success"; readonly body: CaseloadBody }
  | {
      readonly kind: "rate_limited";
      readonly retryAfterSeconds: number;
      readonly failure: MutationFailure;
    }
  | { readonly kind: "failure"; readonly failure: MutationFailure };

interface ErrorEnvelope {
  readonly code?: string;
  readonly message?: string;
  readonly traceId?: string;
  readonly details?: {
    readonly field?: string;
    readonly reason?: string;
    readonly retryAfterSeconds?: number;
    readonly limit?: number;
  };
}

// Conservative fallback when the 429 carries neither `Retry-After` nor
// `details.retryAfterSeconds` (defensive — the spec requires both, but a
// malformed upstream shouldn't lock the button forever). BR-76 window is
// 30s; we use that floor so the button re-enables when the actual window
// has provably elapsed.
const RATE_LIMIT_FALLBACK_SECONDS = 30;

export async function postRefreshCaseload(
  fetchImpl: FetchLike,
  idempotencyKey: string,
): Promise<RefreshOutcome> {
  let res: Response;
  try {
    res = await fetchImpl("/api/v1/caseload/refresh", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      // The endpoint ignores the body; `{}` keeps the request a well-formed
      // JSON POST so Origin / CSRF middlewares treating empty bodies as
      // suspect have nothing to flag.
      body: "{}",
      cache: "no-store",
      credentials: "same-origin",
    });
  } catch (err) {
    return {
      kind: "failure",
      failure: {
        code: "NETWORK_ERROR",
        message: err instanceof Error ? err.message : "Network error.",
        traceId: null,
        field: null,
        reason: null,
      },
    };
  }

  if (res.ok) {
    const body = (await res.json()) as CaseloadBody;
    return { kind: "success", body };
  }

  let envelope: ErrorEnvelope | null = null;
  try {
    envelope = (await res.json()) as ErrorEnvelope;
  } catch {
    envelope = null;
  }
  const failure: MutationFailure = {
    code: envelope?.code ?? `HTTP_${res.status}`,
    message: envelope?.message ?? `Request failed (${res.status}).`,
    traceId: envelope?.traceId ?? res.headers.get("X-Trace-Id"),
    field: envelope?.details?.field ?? null,
    reason: envelope?.details?.reason ?? null,
  };

  if (res.status === 429) {
    const retryAfterSeconds = parseRetryAfter(
      res.headers.get("Retry-After"),
      envelope?.details?.retryAfterSeconds,
    );
    return { kind: "rate_limited", retryAfterSeconds, failure };
  }
  return { kind: "failure", failure };
}

// `Retry-After` (RFC 7231 §7.1.3) is the canonical source. The 429 envelope
// also carries `details.retryAfterSeconds` (API §9.2.1) — used as a fallback
// when the header is missing (e.g. a proxy strips it). Anything else lands
// on the conservative 30s BR-76 window.
function parseRetryAfter(
  header: string | null,
  envelopeSeconds: number | undefined,
): number {
  if (header !== null) {
    const n = Number.parseInt(header, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  if (envelopeSeconds !== undefined && envelopeSeconds > 0) {
    return Math.ceil(envelopeSeconds);
  }
  return RATE_LIMIT_FALLBACK_SECONDS;
}
