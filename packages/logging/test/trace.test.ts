import { describe, expect, it } from "vitest";

import {
  echoTraceId,
  forwardWithTraceId,
  generateTraceId,
  MAX_TRACE_ID_LENGTH,
  resolveTraceId,
} from "../src/trace.js";

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function reqWithTrace(value?: string): Request {
  const headers = new Headers();
  if (value !== undefined) {
    headers.set("X-Trace-Id", value);
  }
  return new Request("https://bff.test/api/x", { headers });
}

describe("generateTraceId", () => {
  it("produces a UUIDv4 (ERD §16 OSQ-18 — ULID rejected)", () => {
    expect(generateTraceId()).toMatch(UUID_V4);
  });

  it("produces a fresh value on each call", () => {
    expect(generateTraceId()).not.toBe(generateTraceId());
  });
});

describe("resolveTraceId — X-Trace-Id wire contract (API §8.5)", () => {
  it("returns an inbound X-Trace-Id verbatim", () => {
    expect(resolveTraceId(reqWithTrace("trace-inbound-1"))).toBe("trace-inbound-1");
  });

  it("generates a UUIDv4 when X-Trace-Id is absent", () => {
    expect(resolveTraceId(reqWithTrace())).toMatch(UUID_V4);
  });

  it("generates a UUIDv4 when X-Trace-Id is empty", () => {
    expect(resolveTraceId(reqWithTrace(""))).toMatch(UUID_V4);
  });

  it("generates a UUIDv4 when X-Trace-Id exceeds the varchar(100) bound", () => {
    expect(resolveTraceId(reqWithTrace("x".repeat(MAX_TRACE_ID_LENGTH + 1)))).toMatch(
      UUID_V4,
    );
  });

  it("accepts an inbound id exactly at the varchar(100) bound", () => {
    const atBound = "y".repeat(MAX_TRACE_ID_LENGTH);
    expect(resolveTraceId(reqWithTrace(atBound))).toBe(atBound);
  });
});

describe("echoTraceId", () => {
  it("sets X-Trace-Id on the response, preserving status, headers, and body", async () => {
    const res = echoTraceId(
      new Response("hello", { status: 207, headers: { "X-Other": "keep" } }),
      "trace-echo-1",
    );
    expect(res.headers.get("X-Trace-Id")).toBe("trace-echo-1");
    expect(res.headers.get("X-Other")).toBe("keep");
    expect(res.status).toBe(207);
    expect(await res.text()).toBe("hello");
  });
});

describe("forwardWithTraceId", () => {
  it("sets X-Trace-Id when the inbound header differs", () => {
    const fwd = forwardWithTraceId(reqWithTrace("old"), "new");
    expect(fwd.headers.get("X-Trace-Id")).toBe("new");
  });

  it("returns the same request untouched when the header already matches", () => {
    const req = reqWithTrace("same");
    expect(forwardWithTraceId(req, "same")).toBe(req);
  });
});
