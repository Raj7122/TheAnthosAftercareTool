import type { DbOrTx } from "@anthos/persistence";
import { describe, expect, it } from "vitest";

import { AuditPiiError, AuditValidationError } from "../src/errors.js";
import type { AuditEntryInput } from "../src/schema.js";
import { writeAuditEntry } from "../src/writer.js";

const FAKE_ROW_ID = "00000000-0000-4000-8000-000000000001";

interface FakeDbHandle {
  db: DbOrTx;
  readonly insertCalls: number;
  readonly insertedValues: ReadonlyArray<Record<string, unknown>>;
  releaseReturning: () => void;
}

// Minimal stand-in for the Drizzle insert builder chain — no live Postgres.
// `deferred` gates returning() so a test can prove the writer awaits the
// INSERT before resolving.
function makeFakeDb(options: { deferred?: boolean } = {}): FakeDbHandle {
  const insertedValues: Record<string, unknown>[] = [];
  let insertCalls = 0;
  let release: () => void = () => {};
  const gate = options.deferred
    ? new Promise<void>((resolve) => {
        release = resolve;
      })
    : Promise.resolve();

  const db = {
    insert() {
      insertCalls += 1;
      return {
        values(value: Record<string, unknown>) {
          insertedValues.push(value);
          return {
            async returning() {
              await gate;
              return [{ id: FAKE_ROW_ID }];
            },
          };
        },
      };
    },
  };

  return {
    db: db as unknown as DbOrTx,
    get insertCalls() {
      return insertCalls;
    },
    insertedValues,
    releaseReturning: () => release(),
  };
}

const validEntry: AuditEntryInput = {
  specialistId: "S-100",
  actionType: "CALL_LOGGED",
  outcome: "SUCCESS",
};

describe("writeAuditEntry — Pattern B / SEC-AUDIT-1a", () => {
  it("performs exactly one INSERT and returns the row id", async () => {
    const fake = makeFakeDb();
    const result = await writeAuditEntry(fake.db, validEntry);
    expect(fake.insertCalls).toBe(1);
    expect(result.id).toBe(FAKE_ROW_ID);
  });

  it("flows trace_id from the entry to the inserted row", async () => {
    const fake = makeFakeDb();
    await writeAuditEntry(fake.db, { ...validEntry, traceId: "trace-xyz-1" });
    expect(fake.insertedValues[0]?.traceId).toBe("trace-xyz-1");
  });

  it("maps omitted optional fields to null in the inserted row", async () => {
    const fake = makeFakeDb();
    await writeAuditEntry(fake.db, validEntry);
    const row = fake.insertedValues[0];
    expect(row?.participantId).toBeNull();
    expect(row?.traceId).toBeNull();
    expect(row?.channel).toBeNull();
    expect(row?.salesforceRecordId).toBeNull();
  });

  it("awaits the INSERT before resolving (no fire-and-forget)", async () => {
    const fake = makeFakeDb({ deferred: true });
    let settled = false;
    const promise = writeAuditEntry(fake.db, validEntry).then((result) => {
      settled = true;
      return result;
    });

    // Flush microtasks — the writer must still be parked on returning().
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(fake.insertCalls).toBe(1);

    fake.releaseReturning();
    const result = await promise;
    expect(settled).toBe(true);
    expect(result.id).toBe(FAKE_ROW_ID);
  });

  it("throws AuditValidationError and does not INSERT a malformed entry", async () => {
    const fake = makeFakeDb();
    await expect(
      writeAuditEntry(fake.db, {
        specialistId: "S-1",
        outcome: "SUCCESS",
      } as unknown as AuditEntryInput),
    ).rejects.toBeInstanceOf(AuditValidationError);
    expect(fake.insertCalls).toBe(0);
  });

  it("throws AuditPiiError and does not INSERT when payload_metadata carries PII", async () => {
    const fake = makeFakeDb();
    await expect(
      writeAuditEntry(fake.db, {
        ...validEntry,
        payloadMetadata: { external_ref: "x@example.com" },
      }),
    ).rejects.toBeInstanceOf(AuditPiiError);
    expect(fake.insertCalls).toBe(0);
  });
});
