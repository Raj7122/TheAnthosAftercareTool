import { describe, expect, it, vi } from "vitest";

import { postRefreshCaseload } from "../../app/caseload/_lib/refresh-request";
import type { FetchLike } from "../../app/caseload/_lib/send-mutation";

function jsonResponse(
  status: number,
  body: unknown,
  headers: HeadersInit = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

describe("postRefreshCaseload — request shaping", () => {
  it("POSTs to /api/v1/caseload/refresh with Idempotency-Key + empty JSON body", async () => {
    const fetchImpl: FetchLike = vi.fn(async () =>
      jsonResponse(200, {
        specialistId: "spec-1",
        queue: "check_ins_due_this_month",
        sort: "priority_desc",
        queueCounts: {},
        cacheAgeSeconds: 0,
        configurationVersion: 1,
        items: [],
      }),
    );
    await postRefreshCaseload(fetchImpl, "key-abc");
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/v1/caseload/refresh",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          "Idempotency-Key": "key-abc",
        }),
        body: "{}",
        cache: "no-store",
        credentials: "same-origin",
      }),
    );
  });

  it("returns success + parsed CaseloadBody on 200", async () => {
    const body = {
      specialistId: "spec-1",
      queue: "check_ins_due_this_month",
      sort: "priority_desc" as const,
      queueCounts: { check_ins_due_this_month: 0 },
      cacheAgeSeconds: 0,
      configurationVersion: 1,
      items: [],
    };
    const fetchImpl: FetchLike = vi.fn(async () => jsonResponse(200, body));
    const out = await postRefreshCaseload(fetchImpl, "k");
    expect(out.kind).toBe("success");
    if (out.kind === "success") {
      expect(out.body).toEqual(body);
    }
  });
});

describe("postRefreshCaseload — 429 rate-limit path", () => {
  it("parses Retry-After header as the canonical retry window", async () => {
    const fetchImpl: FetchLike = vi.fn(async () =>
      jsonResponse(
        429,
        {
          code: "RATE_LIMITED",
          message: "Too many requests. Please wait a moment and try again.",
          traceId: "t-1",
          details: { retryAfterSeconds: 25, limit: 1 },
        },
        { "Retry-After": "27", "X-Trace-Id": "t-1" },
      ),
    );
    const out = await postRefreshCaseload(fetchImpl, "k");
    expect(out.kind).toBe("rate_limited");
    if (out.kind === "rate_limited") {
      expect(out.retryAfterSeconds).toBe(27);
      expect(out.failure.code).toBe("RATE_LIMITED");
      expect(out.failure.traceId).toBe("t-1");
    }
  });

  it("falls back to details.retryAfterSeconds when the header is missing", async () => {
    const fetchImpl: FetchLike = vi.fn(async () =>
      jsonResponse(429, {
        code: "RATE_LIMITED",
        message: "Too many requests.",
        traceId: null,
        details: { retryAfterSeconds: 12, limit: 1 },
      }),
    );
    const out = await postRefreshCaseload(fetchImpl, "k");
    expect(out.kind).toBe("rate_limited");
    if (out.kind === "rate_limited") {
      expect(out.retryAfterSeconds).toBe(12);
    }
  });

  it("falls back to the BR-76 30s window when both signals are absent", async () => {
    const fetchImpl: FetchLike = vi.fn(
      async () =>
        new Response("not json", {
          status: 429,
          headers: { "Content-Type": "text/plain" },
        }),
    );
    const out = await postRefreshCaseload(fetchImpl, "k");
    expect(out.kind).toBe("rate_limited");
    if (out.kind === "rate_limited") {
      expect(out.retryAfterSeconds).toBe(30);
    }
  });
});

describe("postRefreshCaseload — other error paths", () => {
  it("maps a 500 error envelope to a failure outcome", async () => {
    const fetchImpl: FetchLike = vi.fn(async () =>
      jsonResponse(
        500,
        {
          code: "INTERNAL_ERROR",
          message: "Something went wrong. Please try again.",
          traceId: "t-9",
        },
        { "X-Trace-Id": "t-9" },
      ),
    );
    const out = await postRefreshCaseload(fetchImpl, "k");
    expect(out.kind).toBe("failure");
    if (out.kind === "failure") {
      expect(out.failure.code).toBe("INTERNAL_ERROR");
      expect(out.failure.traceId).toBe("t-9");
    }
  });

  it("maps a 503 SF upstream envelope without losing the structured code", async () => {
    const fetchImpl: FetchLike = vi.fn(async () =>
      jsonResponse(503, {
        code: "SF_UPSTREAM_UNAVAILABLE",
        message: "Salesforce is temporarily unavailable. Please try again.",
        traceId: "t-2",
      }),
    );
    const out = await postRefreshCaseload(fetchImpl, "k");
    expect(out.kind).toBe("failure");
    if (out.kind === "failure") {
      expect(out.failure.code).toBe("SF_UPSTREAM_UNAVAILABLE");
    }
  });

  it("returns NETWORK_ERROR on a fetch rejection", async () => {
    const fetchImpl: FetchLike = vi.fn(async () => {
      throw new TypeError("Network blip");
    });
    const out = await postRefreshCaseload(fetchImpl, "k");
    expect(out.kind).toBe("failure");
    if (out.kind === "failure") {
      expect(out.failure.code).toBe("NETWORK_ERROR");
      expect(out.failure.message).toBe("Network blip");
    }
  });

  it("falls back to HTTP_{status} when the error body is not JSON", async () => {
    const fetchImpl: FetchLike = vi.fn(
      async () => new Response("Server error", { status: 502 }),
    );
    const out = await postRefreshCaseload(fetchImpl, "k");
    expect(out.kind).toBe("failure");
    if (out.kind === "failure") {
      expect(out.failure.code).toBe("HTTP_502");
    }
  });
});
