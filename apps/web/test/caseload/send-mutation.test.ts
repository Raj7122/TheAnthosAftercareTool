import { describe, expect, it, vi } from "vitest";

import {
  sendMutation,
  type FetchLike,
} from "../../app/caseload/_lib/send-mutation";

function jsonResponse(status: number, body: unknown, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

describe("sendMutation — request shaping", () => {
  it("sends method + Idempotency-Key + JSON body and returns the parsed response on 2xx", async () => {
    const fetchImpl: FetchLike = vi.fn(async () =>
      jsonResponse(201, { barrierId: "real-1", priorityRecomputed: {} }),
    );
    const out = await sendMutation(fetchImpl, {
      method: "POST",
      url: "/api/v1/participants/p1/barriers",
      idempotencyKey: "key-123",
      body: { type: "Domestic Violence" },
    });
    expect(out.kind).toBe("success");
    if (out.kind === "success") {
      expect(out.body).toEqual({ barrierId: "real-1", priorityRecomputed: {} });
    }
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/v1/participants/p1/barriers",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          "Idempotency-Key": "key-123",
        }),
        body: JSON.stringify({ type: "Domestic Violence" }),
        cache: "no-store",
        credentials: "same-origin",
      }),
    );
  });

  it("propagates X-Trace-Id on the success arm (P1F-05 — for Pattern A reconcile correlation)", async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse(
        201,
        { barrierId: "real-1", priorityRecomputed: {} },
        { "X-Trace-Id": "trace-success" },
      );
    const out = await sendMutation(fetchImpl, {
      method: "POST",
      url: "/api/v1/participants/p1/barriers",
      idempotencyKey: "k",
      body: {},
    });
    expect(out.kind).toBe("success");
    if (out.kind === "success") {
      expect(out.traceId).toBe("trace-success");
    }
  });

  it("returns `null` traceId on the success arm when the header is absent (defensive)", async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse(201, { barrierId: "real-1" });
    const out = await sendMutation(fetchImpl, {
      method: "POST",
      url: "/api/v1/participants/p1/barriers",
      idempotencyKey: "k",
      body: {},
    });
    expect(out.kind).toBe("success");
    if (out.kind === "success") {
      expect(out.traceId).toBeNull();
    }
  });
});

describe("sendMutation — error envelope mapping (API §9.4)", () => {
  it("maps VR-12 (unknown Barrier Type) to field=type / reason=unknown_barrier_type", async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse(422, {
        code: "VALIDATION_FAILED",
        message: "The request failed validation.",
        traceId: "trace-abc",
        details: { field: "type", reason: "unknown_barrier_type" },
      });
    const out = await sendMutation(fetchImpl, {
      method: "POST",
      url: "/api/v1/participants/p1/barriers",
      idempotencyKey: "k",
      body: { type: "Not a real type" },
    });
    expect(out.kind).toBe("failure");
    if (out.kind === "failure") {
      expect(out.failure).toEqual({
        code: "VALIDATION_FAILED",
        message: "The request failed validation.",
        traceId: "trace-abc",
        field: "type",
        reason: "unknown_barrier_type",
      });
    }
  });

  it("maps VR-13 (already-closed) to field=barrier / reason=already_closed", async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse(422, {
        code: "VALIDATION_FAILED",
        message: "The request failed validation.",
        traceId: "trace-xyz",
        details: { field: "barrier", reason: "already_closed" },
      });
    const out = await sendMutation(fetchImpl, {
      method: "PATCH",
      url: "/api/v1/participants/p1/barriers/b1",
      idempotencyKey: "k",
      body: { action: "close" },
    });
    expect(out.kind).toBe("failure");
    if (out.kind === "failure") {
      expect(out.failure.field).toBe("barrier");
      expect(out.failure.reason).toBe("already_closed");
    }
  });

  it("maps VR-14 (missing Type — Zod field error, no `reason`)", async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse(422, {
        code: "VALIDATION_FAILED",
        message: "The request failed validation.",
        traceId: "trace-1",
        details: { field: "type", reason: "type is required" },
      });
    const out = await sendMutation(fetchImpl, {
      method: "POST",
      url: "/api/v1/participants/p1/barriers",
      idempotencyKey: "k",
      body: {},
    });
    expect(out.kind).toBe("failure");
    if (out.kind === "failure") {
      expect(out.failure.field).toBe("type");
    }
  });

  it("falls back to X-Trace-Id header when the response body is not parseable JSON", async () => {
    const fetchImpl: FetchLike = async () =>
      new Response("not json", {
        status: 503,
        headers: { "Content-Type": "text/plain", "X-Trace-Id": "trace-hdr" },
      });
    const out = await sendMutation(fetchImpl, {
      method: "POST",
      url: "/api/v1/participants/p1/barriers",
      idempotencyKey: "k",
      body: {},
    });
    expect(out.kind).toBe("failure");
    if (out.kind === "failure") {
      expect(out.failure.code).toBe("HTTP_503");
      expect(out.failure.traceId).toBe("trace-hdr");
    }
  });

  it("returns NETWORK_ERROR when fetch itself throws (offline / DNS)", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("Failed to fetch");
    };
    const out = await sendMutation(fetchImpl, {
      method: "POST",
      url: "/api/v1/participants/p1/barriers",
      idempotencyKey: "k",
      body: {},
    });
    expect(out.kind).toBe("failure");
    if (out.kind === "failure") {
      expect(out.failure.code).toBe("NETWORK_ERROR");
      expect(out.failure.message).toBe("Failed to fetch");
    }
  });

  it("extracts rule / minLength / actualLength from VR-18 SUMMARY_REQUIRED_FOR_COMPLETED envelope (API §9.4.1)", async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse(422, {
        code: "SUMMARY_REQUIRED_FOR_COMPLETED",
        message:
          "Summary is required and must be at least 10 characters when Status = Completed.",
        traceId: "trace-vr18",
        details: {
          field: "summary",
          rule: "VR-18",
          minLength: 10,
          actualLength: 3,
        },
      });
    const out = await sendMutation(fetchImpl, {
      method: "POST",
      url: "/api/v1/participants/p1/calls",
      idempotencyKey: "k",
      body: { status: "Completed", type: "Check In", serviceDate: "2026-05-24", summary: "ok " },
    });
    expect(out.kind).toBe("failure");
    if (out.kind === "failure") {
      expect(out.failure).toEqual({
        code: "SUMMARY_REQUIRED_FOR_COMPLETED",
        message:
          "Summary is required and must be at least 10 characters when Status = Completed.",
        traceId: "trace-vr18",
        field: "summary",
        reason: null,
        rule: "VR-18",
        minLength: 10,
        actualLength: 3,
      });
    }
  });

  it("does NOT carry rule / minLength / actualLength on non-VR-18 envelopes (they are TS-optional, absent rather than null)", async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse(422, {
        code: "VALIDATION_FAILED",
        message: "The request failed validation.",
        traceId: "trace-abc",
        details: { field: "type", reason: "unknown_barrier_type" },
      });
    const out = await sendMutation(fetchImpl, {
      method: "POST",
      url: "/api/v1/participants/p1/barriers",
      idempotencyKey: "k",
      body: { type: "Not a real type" },
    });
    if (out.kind === "failure") {
      expect(out.failure).not.toHaveProperty("rule");
      expect(out.failure).not.toHaveProperty("minLength");
      expect(out.failure).not.toHaveProperty("actualLength");
    }
  });
});
