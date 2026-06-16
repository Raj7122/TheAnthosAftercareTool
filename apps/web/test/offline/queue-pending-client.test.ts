// P3C-12 — fetcher coverage for `fetchQueuePending` + `postQueueResolve`.
//
// Asserts the wire shape the BFF expects (URL, method, headers, body
// serialization, cache + credentials), and the outcome envelope the hook
// branches on (success / unauthenticated / forbidden / failure / network).

import { describe, expect, it, vi } from "vitest";

import {
  fetchQueuePending,
  postQueueResolve,
} from "../../app/_lib/offline/queue-pending-client";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("fetchQueuePending", () => {
  it("GETs /api/v1/queue/pending with no-store and same-origin", async () => {
    const fetchImpl = vi.fn(
      async (
        _input: RequestInfo | URL,
        _init?: RequestInit,
      ): Promise<Response> =>
        jsonResponse(200, {
          specialistId: "spec-1",
          items: [],
          counts: {},
          queueDepth: 0,
          maxQueueDepth: 100,
        }),
    );
    const outcome = await fetchQueuePending(fetchImpl);

    expect(outcome.kind).toBe("success");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("/api/v1/queue/pending");
    expect(init?.method).toBe("GET");
    expect(init?.cache).toBe("no-store");
    expect(init?.credentials).toBe("same-origin");
  });

  it("returns unauthenticated on 401", async () => {
    const fetchImpl = vi.fn(
      async (
        _input: RequestInfo | URL,
        _init?: RequestInit,
      ): Promise<Response> => jsonResponse(401, { code: "UNAUTH" }),
    );
    const outcome = await fetchQueuePending(fetchImpl);
    expect(outcome.kind).toBe("unauthenticated");
  });

  it("returns forbidden on 403", async () => {
    const fetchImpl = vi.fn(
      async (
        _input: RequestInfo | URL,
        _init?: RequestInit,
      ): Promise<Response> => jsonResponse(403, { code: "FORBIDDEN" }),
    );
    const outcome = await fetchQueuePending(fetchImpl);
    expect(outcome.kind).toBe("forbidden");
  });

  it("returns failure with envelope fields on 5xx", async () => {
    const fetchImpl = vi.fn(
      async (
        _input: RequestInfo | URL,
        _init?: RequestInit,
      ): Promise<Response> =>
        new Response(
          JSON.stringify({
            code: "DATABASE_ERROR",
            message: "Boom.",
            traceId: "trace-9",
          }),
          { status: 500, headers: { "Content-Type": "application/json" } },
        ),
    );
    const outcome = await fetchQueuePending(fetchImpl);
    expect(outcome.kind).toBe("failure");
    if (outcome.kind !== "failure") return;
    expect(outcome.failure.code).toBe("DATABASE_ERROR");
    expect(outcome.failure.message).toBe("Boom.");
    expect(outcome.failure.status).toBe(500);
    expect(outcome.failure.traceId).toBe("trace-9");
  });

  it("returns failure with NETWORK_ERROR on thrown fetch", async () => {
    const fetchImpl = vi.fn(
      async (
        _input: RequestInfo | URL,
        _init?: RequestInit,
      ): Promise<Response> => {
        throw new Error("offline");
      },
    );
    const outcome = await fetchQueuePending(fetchImpl);
    expect(outcome.kind).toBe("failure");
    if (outcome.kind !== "failure") return;
    expect(outcome.failure.code).toBe("NETWORK_ERROR");
    expect(outcome.failure.message).toBe("offline");
    expect(outcome.failure.status).toBe(0);
  });
});

describe("postQueueResolve", () => {
  it("POSTs to /api/v1/queue/:id/resolve with the Idempotency-Key header", async () => {
    const fetchImpl = vi.fn(
      async (
        _input: RequestInfo | URL,
        _init?: RequestInit,
      ): Promise<Response> =>
        jsonResponse(200, {
          queueItemId: "q-1",
          status: "discarded",
          resolvedAt: "2026-05-27T00:00:00Z",
          resolvedBy: "spec-1",
          resolutionSource: "specialist",
        }),
    );
    const outcome = await postQueueResolve(fetchImpl, {
      queueItemId: "q-1",
      idempotencyKey: "uuid-test",
      request: { action: "DISCARD" },
    });

    expect(outcome.kind).toBe("success");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("/api/v1/queue/q-1/resolve");
    expect(init?.method).toBe("POST");
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers?.["Content-Type"]).toBe("application/json");
    expect(headers?.["Idempotency-Key"]).toBe("uuid-test");
    expect(init?.cache).toBe("no-store");
    expect(init?.credentials).toBe("same-origin");
    expect(init?.body).toBe(JSON.stringify({ action: "DISCARD" }));
  });

  it("URL-encodes the queue item id", async () => {
    const fetchImpl = vi.fn(
      async (
        _input: RequestInfo | URL,
        _init?: RequestInit,
      ): Promise<Response> =>
        jsonResponse(200, {
          queueItemId: "weird id",
          status: "discarded",
          resolvedAt: "2026-05-27T00:00:00Z",
          resolvedBy: "spec-1",
          resolutionSource: "specialist",
        }),
    );
    await postQueueResolve(fetchImpl, {
      queueItemId: "weird id",
      idempotencyKey: "k",
      request: { action: "DISCARD" },
    });
    expect(fetchImpl.mock.calls[0]![0]).toBe(
      "/api/v1/queue/weird%20id/resolve",
    );
  });

  it("surfaces 400 envelope on REASSIGN_RETRY missing newOwnerId", async () => {
    const fetchImpl = vi.fn(
      async (
        _input: RequestInfo | URL,
        _init?: RequestInit,
      ): Promise<Response> =>
        jsonResponse(400, {
          code: "VALIDATION_FAILED",
          message: "newOwnerId is required when action is REASSIGN_RETRY",
          details: { field: "newOwnerId" },
        }),
    );
    const outcome = await postQueueResolve(fetchImpl, {
      queueItemId: "q-1",
      idempotencyKey: "k",
      request: { action: "REASSIGN_RETRY" } as never,
    });
    expect(outcome.kind).toBe("failure");
    if (outcome.kind !== "failure") return;
    expect(outcome.failure.code).toBe("VALIDATION_FAILED");
    expect(outcome.failure.field).toBe("newOwnerId");
    expect(outcome.failure.status).toBe(400);
  });
});
