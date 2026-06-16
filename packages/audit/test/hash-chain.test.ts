import { describe, expect, it } from "vitest";

import { computeHash, hashColumns, type HashableAuditRow } from "../src/hash-chain.js";

const row: HashableAuditRow = {
  specialistId: "S-1",
  participantId: null,
  actionType: "CALL_LOGGED",
  outcome: "SUCCESS",
  channel: null,
  salesforceRecordId: null,
  traceId: null,
  payloadMetadata: {},
};

describe("computeHash — Demo Mode stub (slaughter-list #3)", () => {
  it("returns null regardless of previousHash", () => {
    expect(computeHash(row, null)).toBeNull();
    expect(computeHash(row, "some-prior-hash")).toBeNull();
  });

  it("is deterministic for identical inputs", () => {
    expect(computeHash(row, null)).toBe(computeHash(row, null));
  });

  it("does not mutate the entry", () => {
    const snapshot = structuredClone(row);
    computeHash(row, "prior");
    expect(row).toEqual(snapshot);
  });
});

describe("hashColumns — Demo Mode", () => {
  it("returns an empty object (audit_log has no hash columns in Demo)", () => {
    expect(hashColumns(row, null)).toEqual({});
  });
});
