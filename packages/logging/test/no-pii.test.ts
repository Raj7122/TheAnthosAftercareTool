import { describe, expect, it } from "vitest";

import { LogPiiError } from "../src/errors.js";
import { assertLogSafe } from "../src/no-pii.js";

// The log firewall reuses @anthos/audit's SEC-AUDIT-4 primitives — one source
// of truth for what counts as PII (no PII in logs).

describe("assertLogSafe — log PII firewall", () => {
  it("passes a clean message with clean structural fields", () => {
    expect(() =>
      assertLogSafe("idempotency middleware rejection: in_flight", {
        event: "idempotency_in_flight",
        idempotency_key_prefix: "11111111",
      }),
    ).not.toThrow();
  });

  it("blocks an email address in the message", () => {
    expect(() => assertLogSafe("contacted jane@example.com", {})).toThrow(
      LogPiiError,
    );
  });

  it("blocks a phone number in the message", () => {
    expect(() => assertLogSafe("called 212-555-0199", {})).toThrow(LogPiiError);
  });

  it("blocks a PII-denied field key (a specialist / participant name)", () => {
    expect(() => assertLogSafe("ok", { participantName: "redacted" })).toThrow(
      LogPiiError,
    );
  });

  it("blocks an email address in a field value", () => {
    expect(() => assertLogSafe("ok", { external_ref: "x@example.com" })).toThrow(
      LogPiiError,
    );
  });

  it("blocks a field that smuggles message content", () => {
    expect(() => assertLogSafe("ok", { message: "free text" })).toThrow(
      LogPiiError,
    );
  });

  it("surfaces rule + keyPath rooted at `fields`, withholding the value", () => {
    try {
      assertLogSafe("ok", { external_ref: "x@example.com" });
      expect.fail("assertLogSafe should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(LogPiiError);
      const pii = err as LogPiiError;
      expect(pii.keyPath).toBe("fields.external_ref");
      expect(pii.rule).toBe("value:email-address");
      expect(pii.message).not.toContain("x@example.com");
    }
  });

  it("reports the `message` path when the message itself carries PII", () => {
    try {
      assertLogSafe("reach me at jane@example.com", {});
      expect.fail("assertLogSafe should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(LogPiiError);
      expect((err as LogPiiError).keyPath).toBe("message");
    }
  });
});
