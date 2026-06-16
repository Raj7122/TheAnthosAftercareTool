// HTTP client for F-06 Barrier mutations — translates an `(method, url,
// idempotency-key, body)` tuple into a `Response`-derived outcome the
// optimistic-UI hook can reconcile against. Extracted from
// `useCaseloadMutations.ts` so the request-shaping logic + error-envelope
// mapping can be unit-tested without React.

export type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

// Structured failure shape the hook re-exports for sheets to render inline.
// `code`/`reason` mirror the API §9 envelope so the sheet can map
// VR-12/13/14 to the field that drove them ({field: "type"} → Type
// required/unknown; {field: "barrier", reason: "already_closed"} → VR-13).
//
// `rule`/`minLength`/`actualLength` carry the F-08 VR-18
// `SUMMARY_REQUIRED_FOR_COMPLETED` envelope's extras (API §9.4.1 sample) so
// the sheet can render a live "n/min" counter. These are TS-optional (not
// required-nullable like `field`/`reason`) because they are semantically
// VR-18-only — refresh / barrier / non-VR-18-validation paths never produce
// them, so forcing every callsite to construct three explicit `null`s would
// be noise. Consumers read via `?.` and `??` defaults.
export interface MutationFailure {
  readonly code: string;
  readonly message: string;
  readonly traceId: string | null;
  readonly field: string | null;
  readonly reason: string | null;
  readonly rule?: string;
  readonly minLength?: number;
  readonly actualLength?: number;
  // E-11 QUIET_HOURS_BLOCKED (409) extra: the next allowed send instant (ISO)
  // so the SMS sheet can offer "Schedule for <time>". Only set when the
  // envelope carried it; absent on every other path.
  readonly nextAllowedWindowStart?: string;
}

export interface MutationRequest {
  readonly method: "POST" | "PATCH";
  readonly url: string;
  readonly idempotencyKey: string;
  readonly body: unknown;
}

export type MutationOutcome =
  | {
      readonly kind: "success";
      readonly body: unknown;
      // P1F-05: `X-Trace-Id` from the 2xx response. Propagated so the SPA's
      // Pattern A reconcile (recent-case-notes store) can correlate the
      // local optimistic→confirmed transition to the BFF's pre-response
      // Pattern B audit row. Optional because not every consumer needs it
      // (barriers ignores it; log-call carries it onto the LocalCaseNote).
      readonly traceId: string | null;
    }
  | { readonly kind: "failure"; readonly failure: MutationFailure };

export async function sendMutation(
  fetchImpl: FetchLike,
  request: MutationRequest,
): Promise<MutationOutcome> {
  let res: Response;
  try {
    res = await fetchImpl(request.url, {
      method: request.method,
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": request.idempotencyKey,
      },
      body: JSON.stringify(request.body),
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
    const body = (await res.json()) as unknown;
    return {
      kind: "success",
      body,
      traceId: res.headers.get("X-Trace-Id"),
    };
  }

  // Error envelope per API §9.4 — `{ code, message, traceId, details? }`. We
  // tolerate non-JSON bodies (e.g. an Origin reject) by falling back to the
  // status line.
  let envelope: ErrorEnvelope | null = null;
  try {
    envelope = (await res.json()) as ErrorEnvelope;
  } catch {
    envelope = null;
  }
  return {
    kind: "failure",
    failure: {
      code: envelope?.code ?? `HTTP_${res.status}`,
      message: envelope?.message ?? `Request failed (${res.status}).`,
      traceId: envelope?.traceId ?? res.headers.get("X-Trace-Id"),
      field: envelope?.details?.field ?? null,
      reason: envelope?.details?.reason ?? null,
      // VR-18 extras: only set if the envelope carried them. `undefined`
      // (optional-absent) is the contract for "not applicable to this code".
      ...(envelope?.details?.rule !== undefined ? { rule: envelope.details.rule } : {}),
      ...(envelope?.details?.minLength !== undefined
        ? { minLength: envelope.details.minLength }
        : {}),
      ...(envelope?.details?.actualLength !== undefined
        ? { actualLength: envelope.details.actualLength }
        : {}),
      ...(envelope?.details?.nextAllowedWindowStart !== undefined
        ? { nextAllowedWindowStart: envelope.details.nextAllowedWindowStart }
        : {}),
    },
  };
}

interface ErrorEnvelope {
  readonly code?: string;
  readonly message?: string;
  readonly traceId?: string;
  readonly details?: {
    readonly field?: string;
    readonly reason?: string;
    readonly rule?: string;
    readonly minLength?: number;
    readonly actualLength?: number;
    readonly nextAllowedWindowStart?: string;
  };
}
