import { describe, expect, it } from "vitest";

import { AUDIT_CHANNELS, auditEntrySchema } from "../src/schema.js";

const base = {
  specialistId: "S-100",
  actionType: "CALL_LOGGED",
  outcome: "SUCCESS",
};

describe("auditEntrySchema — SEC-AUDIT-1a", () => {
  it("accepts a minimal entry and defaults payloadMetadata to {}", () => {
    const parsed = auditEntrySchema.parse(base);
    expect(parsed.payloadMetadata).toEqual({});
  });

  it("rejects an entry missing actionType", () => {
    expect(
      auditEntrySchema.safeParse({ specialistId: "S-1", outcome: "SUCCESS" })
        .success,
    ).toBe(false);
  });

  it("rejects an entry missing specialistId", () => {
    expect(
      auditEntrySchema.safeParse({ actionType: "CALL_LOGGED", outcome: "SUCCESS" })
        .success,
    ).toBe(false);
  });

  it("rejects an entry missing outcome", () => {
    expect(
      auditEntrySchema.safeParse({ specialistId: "S-1", actionType: "CALL_LOGGED" })
        .success,
    ).toBe(false);
  });

  it("rejects an outcome outside SUCCESS/FAILED/QUEUED", () => {
    expect(auditEntrySchema.safeParse({ ...base, outcome: "PENDING" }).success).toBe(
      false,
    );
  });

  it("accepts every audit outcome", () => {
    for (const outcome of ["SUCCESS", "FAILED", "QUEUED"]) {
      expect(auditEntrySchema.safeParse({ ...base, outcome }).success).toBe(true);
    }
  });

  it("rejects a channel outside the audit_log CHECK set", () => {
    expect(auditEntrySchema.safeParse({ ...base, channel: "fax" }).success).toBe(
      false,
    );
  });

  it("accepts every audit_log channel", () => {
    for (const channel of AUDIT_CHANNELS) {
      expect(auditEntrySchema.safeParse({ ...base, channel }).success).toBe(true);
    }
  });

  it("rejects a specialistId longer than 50 characters", () => {
    expect(
      auditEntrySchema.safeParse({ ...base, specialistId: "S".repeat(51) }).success,
    ).toBe(false);
  });

  it("carries trace_id and participant_id through when provided", () => {
    const parsed = auditEntrySchema.parse({
      ...base,
      participantId: "P-9",
      traceId: "trace-1",
    });
    expect(parsed.participantId).toBe("P-9");
    expect(parsed.traceId).toBe("trace-1");
  });
});
