import { describe, expect, it } from "vitest";

import type { OriginConfig } from "../../src/origin/config.js";
import {
  isOriginAllowed,
  isSafeMethod,
  sanitizeOriginForAudit,
} from "../../src/origin/validate.js";

const CONFIG: OriginConfig = {
  allowedOrigins: ["https://app.example", "http://localhost:3000"],
};

describe("isSafeMethod", () => {
  it("treats GET / HEAD / OPTIONS as safe (case-insensitive)", () => {
    for (const method of ["GET", "get", "HEAD", "head", "OPTIONS", "options"]) {
      expect(isSafeMethod(method)).toBe(true);
    }
  });

  it("treats state-changing methods as unsafe", () => {
    for (const method of ["POST", "PATCH", "DELETE", "PUT"]) {
      expect(isSafeMethod(method)).toBe(false);
    }
  });
});

describe("isOriginAllowed", () => {
  it("accepts an Origin exactly in the allowlist", () => {
    expect(isOriginAllowed("https://app.example", CONFIG)).toBe(true);
    expect(isOriginAllowed("http://localhost:3000", CONFIG)).toBe(true);
  });

  it("accepts an Origin with a trailing slash (normalized away)", () => {
    expect(isOriginAllowed("https://app.example/", CONFIG)).toBe(true);
  });

  it("rejects an Origin not in the allowlist", () => {
    expect(isOriginAllowed("https://evil.example", CONFIG)).toBe(false);
  });

  it("rejects a null or empty Origin — anomalous on a mutation", () => {
    expect(isOriginAllowed(null, CONFIG)).toBe(false);
    expect(isOriginAllowed("", CONFIG)).toBe(false);
    expect(isOriginAllowed("   ", CONFIG)).toBe(false);
  });

  it("rejects everything when the allowlist is empty — fails closed", () => {
    expect(isOriginAllowed("https://app.example", { allowedOrigins: [] })).toBe(false);
  });
});

describe("sanitizeOriginForAudit", () => {
  it("passes a well-formed origin through unchanged", () => {
    expect(sanitizeOriginForAudit("https://evil.example")).toBe("https://evil.example");
    expect(sanitizeOriginForAudit("http://localhost:3000")).toBe("http://localhost:3000");
  });

  it("maps a null or empty Origin to \"absent\"", () => {
    expect(sanitizeOriginForAudit(null)).toBe("absent");
    expect(sanitizeOriginForAudit("   ")).toBe("absent");
  });

  it("preserves the opaque-origin literal \"null\"", () => {
    expect(sanitizeOriginForAudit("null")).toBe("null");
  });

  it("maps an adversarial non-origin value to \"malformed\" — keeps PII out of the audit", () => {
    expect(sanitizeOriginForAudit("attacker@evil.example")).toBe("malformed");
    expect(sanitizeOriginForAudit("https://evil.example/path?x=1")).toBe("malformed");
    expect(sanitizeOriginForAudit("not a url at all")).toBe("malformed");
  });
});
