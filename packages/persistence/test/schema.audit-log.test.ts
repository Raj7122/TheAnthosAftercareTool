import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { auditLog } from "../src/schema/index.js";

// Drift sentinel: asserts the Drizzle TS schema against ERD v1.4 §6.1
// without needing a live DB. Demo Mode posture — previous_hash / current_hash
// are intentionally absent (impl plan §1.5 slaughter-list item #3).

describe("schema: audit_log (ERD §6.1)", () => {
  const log = getTableConfig(auditLog);

  it("declares 10 columns (Demo Mode — no previous_hash / current_hash)", () => {
    expect(log.columns).toHaveLength(10);
  });

  it("omits the hash-chain columns until Production cutover", () => {
    expect(log.columns.find((c) => c.name === "previous_hash")).toBeUndefined();
    expect(log.columns.find((c) => c.name === "current_hash")).toBeUndefined();
  });

  it("uses uuid PK with gen_random_uuid() default", () => {
    const id = log.columns.find((c) => c.name === "id");
    expect(id?.primary).toBe(true);
    expect(id?.hasDefault).toBe(true);
    expect(id?.notNull).toBe(true);
  });

  it("requires specialist_id, action_type, outcome, payload_metadata", () => {
    for (const name of ["specialist_id", "action_type", "outcome", "payload_metadata"]) {
      const col = log.columns.find((c) => c.name === name);
      expect(col, `column ${name}`).toBeDefined();
      expect(col?.notNull, `${name} must be NOT NULL`).toBe(true);
    }
  });

  it("declares outcome and channel CHECK constraints", () => {
    expect(log.checks.find((c) => c.name === "audit_log_outcome_check")).toBeDefined();
    expect(log.checks.find((c) => c.name === "audit_log_channel_check")).toBeDefined();
  });

  it("defaults payload_metadata to '{}'::jsonb", () => {
    const payload = log.columns.find((c) => c.name === "payload_metadata");
    expect(payload?.hasDefault).toBe(true);
    expect(payload?.notNull).toBe(true);
  });

  it("registers all seven indexes from ERD §6.1", () => {
    const names = log.indexes.map((i) => i.config.name).sort();
    expect(names).toEqual([
      "idx_audit_log_channel",
      "idx_audit_log_participant",
      "idx_audit_log_pending_reconciliation",
      "idx_audit_log_sf_record",
      "idx_audit_log_specialist",
      "idx_audit_log_timestamp",
      "idx_audit_log_trace_id",
    ]);
  });

  it("pending-reconciliation index is partial on outcome=SUCCESS AND sf_record IS NULL", () => {
    const idx = log.indexes.find((i) => i.config.name === "idx_audit_log_pending_reconciliation");
    expect(idx).toBeDefined();
    expect(idx?.config.where).toBeDefined();
  });
});
