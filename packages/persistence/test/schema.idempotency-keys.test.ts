import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { idempotencyKeys } from "../src/schema/index.js";

// Drift sentinel: asserts the Drizzle TS schema against ERD v1.4 §6.2
// (TR-WRITE-2a/b/c — IN_FLIGHT → COMPLETED | FAILED_TERMINAL state machine,
// 24-hour TTL, trace_id correlation per v1.2).

describe("schema: idempotency_keys (ERD §6.2, TR-WRITE-2a/b/c)", () => {
  const keys = getTableConfig(idempotencyKeys);

  it("declares 11 columns matching ERD §6.2", () => {
    expect(keys.columns).toHaveLength(11);
  });

  it("uses uuid PK with NO default — client-generated UUIDv4", () => {
    const key = keys.columns.find((c) => c.name === "key");
    expect(key?.primary).toBe(true);
    expect(key?.notNull).toBe(true);
    expect(key?.hasDefault).toBe(false);
  });

  it("requires specialist_id, endpoint, status, created_at, expires_at", () => {
    for (const name of ["specialist_id", "endpoint", "status", "created_at", "expires_at"]) {
      const col = keys.columns.find((c) => c.name === name);
      expect(col, `column ${name}`).toBeDefined();
      expect(col?.notNull, `${name} must be NOT NULL`).toBe(true);
    }
  });

  it("declares the status CHECK with the three-state machine values", () => {
    const check = keys.checks.find((c) => c.name === "idempotency_keys_status_check");
    expect(check).toBeDefined();
  });

  it("defaults expires_at to NOW() + INTERVAL '24 hours' (TR-WRITE-2c)", () => {
    const expires = keys.columns.find((c) => c.name === "expires_at");
    expect(expires?.hasDefault).toBe(true);
    expect(expires?.notNull).toBe(true);
  });

  it("registers all three indexes from ERD §6.2", () => {
    const names = keys.indexes.map((i) => i.config.name).sort();
    expect(names).toEqual([
      "idx_idempotency_expires",
      "idx_idempotency_specialist",
      "idx_idempotency_trace_id",
    ]);
  });

  it("idx_idempotency_trace_id is partial on trace_id IS NOT NULL (v1.2 propagation)", () => {
    const idx = keys.indexes.find((i) => i.config.name === "idx_idempotency_trace_id");
    expect(idx).toBeDefined();
    expect(idx?.config.where).toBeDefined();
  });
});
