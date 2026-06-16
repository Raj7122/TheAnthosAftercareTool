// P3C-12 — client wrappers for E-17 (`GET /api/v1/queue/pending`) and
// E-19 (`POST /api/v1/queue/:id/resolve`).
//
// Modeled on `apps/web/app/caseload/_lib/send-mutation.ts`: a native
// `fetch` is wrapped in an injectable `FetchLike`, and every call returns
// a structured outcome so the hook can branch on `kind` instead of
// re-parsing `Response` headers/status codes. `401`/`403` are split out
// of the failure axis so the indicator can render `null` (no chip) for
// unauthenticated paths or non-SPECIALIST roles without surfacing an
// error banner.
//
// Type-only imports per the client bundle firewall (memory
// `feedback_client_bundle_anthos_api.md`) — value imports from
// `@anthos/api` would drag `pg` into the SPA chunk.

import type {
  QueuePendingBody,
  QueueResolveBody,
  QueueResolveRequest,
} from "@anthos/api";

export type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface QueueFailure {
  readonly code: string;
  readonly message: string;
  readonly status: number;
  readonly field: string | null;
  readonly traceId: string | null;
}

export type FetchPendingOutcome =
  | { readonly kind: "success"; readonly body: QueuePendingBody }
  | { readonly kind: "unauthenticated" }
  | { readonly kind: "forbidden" }
  | { readonly kind: "failure"; readonly failure: QueueFailure };

export type ResolveOutcome =
  | { readonly kind: "success"; readonly body: QueueResolveBody }
  | { readonly kind: "failure"; readonly failure: QueueFailure };

export interface PostQueueResolveInput {
  readonly queueItemId: string;
  // Idempotency-Key per Pattern D / TR-WRITE-2. Caller-minted so the
  // hook can re-use the same key on a UI-driven retry while we keep this
  // module pure for testing.
  readonly idempotencyKey: string;
  readonly request: QueueResolveRequest;
}

export async function fetchQueuePending(
  fetchImpl: FetchLike,
): Promise<FetchPendingOutcome> {
  let res: Response;
  try {
    res = await fetchImpl("/api/v1/queue/pending", {
      method: "GET",
      cache: "no-store",
      credentials: "same-origin",
    });
  } catch (err) {
    return {
      kind: "failure",
      failure: networkFailure(err),
    };
  }
  if (res.status === 401) return { kind: "unauthenticated" };
  if (res.status === 403) return { kind: "forbidden" };
  if (res.ok) {
    const body = (await res.json()) as QueuePendingBody;
    return { kind: "success", body };
  }
  return { kind: "failure", failure: await readErrorEnvelope(res) };
}

export async function postQueueResolve(
  fetchImpl: FetchLike,
  input: PostQueueResolveInput,
): Promise<ResolveOutcome> {
  let res: Response;
  try {
    res = await fetchImpl(
      `/api/v1/queue/${encodeURIComponent(input.queueItemId)}/resolve`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": input.idempotencyKey,
        },
        body: JSON.stringify(input.request),
        cache: "no-store",
        credentials: "same-origin",
      },
    );
  } catch (err) {
    return {
      kind: "failure",
      failure: networkFailure(err),
    };
  }
  if (res.ok) {
    const body = (await res.json()) as QueueResolveBody;
    return { kind: "success", body };
  }
  return { kind: "failure", failure: await readErrorEnvelope(res) };
}

interface ErrorEnvelope {
  readonly code?: string;
  readonly message?: string;
  readonly traceId?: string;
  readonly details?: { readonly field?: string };
}

async function readErrorEnvelope(res: Response): Promise<QueueFailure> {
  let envelope: ErrorEnvelope | null = null;
  try {
    envelope = (await res.json()) as ErrorEnvelope;
  } catch {
    envelope = null;
  }
  return {
    code: envelope?.code ?? `HTTP_${res.status}`,
    message: envelope?.message ?? `Request failed (${res.status}).`,
    status: res.status,
    field: envelope?.details?.field ?? null,
    traceId: envelope?.traceId ?? res.headers.get("X-Trace-Id"),
  };
}

function networkFailure(err: unknown): QueueFailure {
  return {
    code: "NETWORK_ERROR",
    message: err instanceof Error ? err.message : "Network error.",
    status: 0,
    field: null,
    traceId: null,
  };
}
