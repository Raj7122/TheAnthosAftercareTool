import { describe, expect, it } from "vitest";

import { AuditPiiError } from "../src/errors.js";
import { assertNoPii } from "../src/no-pii.js";

describe("assertNoPii — SEC-AUDIT-4", () => {
  it("passes a clean structural payload", () => {
    expect(() =>
      assertNoPii({
        barrier_type_id: "high-housing",
        attempt_count: 3,
        queued: true,
      }),
    ).not.toThrow();
  });

  it("passes allowed identifiers (Salesforce ID, UUID)", () => {
    expect(() =>
      assertNoPii({
        salesforce_record_id: "001000000000000AAA",
        request_uuid: "00000000-0000-4000-8000-000000000000",
      }),
    ).not.toThrow();
  });

  it("throws on a denied top-level key", () => {
    expect(() => assertNoPii({ phone: "redacted" })).toThrow(AuditPiiError);
  });

  it("throws on a denied key nested in an object", () => {
    expect(() => assertNoPii({ contact: { full_name: "redacted" } })).toThrow(
      AuditPiiError,
    );
  });

  it("throws on a denied key inside an array", () => {
    expect(() => assertNoPii({ items: [{ message: "redacted" }] })).toThrow(
      AuditPiiError,
    );
  });

  it("throws on a camelCase denied key", () => {
    expect(() => assertNoPii({ phoneNumber: "redacted" })).toThrow(AuditPiiError);
  });

  it("throws on an email address in a value", () => {
    expect(() => assertNoPii({ external_ref: "x@example.com" })).toThrow(
      AuditPiiError,
    );
  });

  it("throws on a phone number in a value (separated, bare, and numeric)", () => {
    expect(() => assertNoPii({ external_ref: "212-555-0199" })).toThrow(
      AuditPiiError,
    );
    expect(() => assertNoPii({ external_ref: "2125550199" })).toThrow(
      AuditPiiError,
    );
    expect(() => assertNoPii({ external_ref: 2125550199 })).toThrow(AuditPiiError);
  });

  it("throws on a 64-char SHA-256 hash in a value", () => {
    expect(() => assertNoPii({ external_ref: "a".repeat(64) })).toThrow(
      AuditPiiError,
    );
  });

  it("does not flag a 13-digit epoch-millis number as a phone number", () => {
    expect(() => assertNoPii({ recorded_at_ms: 1747699200000 })).not.toThrow();
  });

  it("surfaces keyPath and rule but withholds the offending value", () => {
    try {
      assertNoPii({ external_ref: "x@example.com" });
      expect.fail("assertNoPii should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AuditPiiError);
      const pii = err as AuditPiiError;
      expect(pii.keyPath).toBe("payload_metadata.external_ref");
      expect(pii.rule).toBe("value:email-address");
      expect(pii.message).not.toContain("x@example.com");
    }
  });
});
