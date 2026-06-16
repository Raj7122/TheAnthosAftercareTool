import { describe, expect, it } from "vitest";

import { canonicalJson, computeRequestHash } from "../../src/idempotency/request-hash.js";

describe("canonicalJson", () => {
  it("is independent of object key order", () => {
    expect(canonicalJson('{"a":1,"b":2}')).toBe(canonicalJson('{"b":2,"a":1}'));
  });

  it("is independent of insignificant whitespace", () => {
    expect(canonicalJson('{"a":1}')).toBe(canonicalJson('{ "a" : 1 }'));
  });

  it("sorts keys recursively through nested objects and arrays", () => {
    const a = canonicalJson('{"outer":{"y":2,"x":1},"list":[{"b":2,"a":1}]}');
    const b = canonicalJson('{"list":[{"a":1,"b":2}],"outer":{"x":1,"y":2}}');
    expect(a).toBe(b);
  });

  it("returns an empty string for an empty body", () => {
    expect(canonicalJson("")).toBe("");
  });

  it("falls back to raw text for a non-JSON body", () => {
    expect(canonicalJson("not json")).toBe("not json");
  });
});

describe("computeRequestHash", () => {
  it("produces a 64-character hex SHA-256 digest", () => {
    const hash = computeRequestHash("POST", "/api/calls", '{"a":1}');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable across equivalent bodies with different key order", () => {
    expect(computeRequestHash("POST", "/api/calls", '{"a":1,"b":2}')).toBe(
      computeRequestHash("POST", "/api/calls", '{"b":2,"a":1}'),
    );
  });

  it("differs when the body differs", () => {
    expect(computeRequestHash("POST", "/api/calls", '{"a":1}')).not.toBe(
      computeRequestHash("POST", "/api/calls", '{"a":2}'),
    );
  });

  it("differs when the method or path differs", () => {
    const base = computeRequestHash("POST", "/api/calls", '{"a":1}');
    expect(computeRequestHash("PATCH", "/api/calls", '{"a":1}')).not.toBe(base);
    expect(computeRequestHash("POST", "/api/sms", '{"a":1}')).not.toBe(base);
  });
});
