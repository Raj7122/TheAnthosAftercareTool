import { getTableName } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  type OfflineQueueStatus,
  type ResolutionAction,
  type ResolutionSource,
  offlineQueue,
} from "../src/schema/index.js";

// Drift sentinel for the P3C-04 `offline_queue` schema (ERD §6.3). Keep in
// lockstep with migration 0010 and the ERD entry; a change to either MUST
// update this test or it will fail in CI.

describe("schema: offline_queue (P3C-04, ERD §6.3)", () => {
  const table = getTableConfig(offlineQueue);

  it("declares exactly 17 columns", () => {
    expect(table.columns).toHaveLength(17);
  });

  it("id is uuid PK with NO default (client-generated at enqueue, TR-OFFLINE-6a)", () => {
    const id = table.columns.find((c) => c.name === "id");
    expect(id?.primary).toBe(true);
    expect(id?.notNull).toBe(true);
    expect(id?.getSQLType()).toBe("uuid");
    expect(id?.hasDefault).toBe(false);
  });

  it("specialist_id is NOT NULL varchar(50)", () => {
    const col = table.columns.find((c) => c.name === "specialist_id");
    expect(col?.notNull).toBe(true);
    expect(col?.getSQLType()).toBe("varchar(50)");
  });

  it("action_type is NOT NULL varchar(100)", () => {
    const col = table.columns.find((c) => c.name === "action_type");
    expect(col?.notNull).toBe(true);
    expect(col?.getSQLType()).toBe("varchar(100)");
  });

  it("payload is NOT NULL jsonb with no default", () => {
    const col = table.columns.find((c) => c.name === "payload");
    expect(col?.notNull).toBe(true);
    expect(col?.getSQLType()).toBe("jsonb");
    expect(col?.hasDefault).toBe(false);
  });

  it("idempotency_key is nullable uuid (FK SET NULL on idempotency_keys delete)", () => {
    const col = table.columns.find((c) => c.name === "idempotency_key");
    expect(col?.notNull).toBe(false);
    expect(col?.getSQLType()).toBe("uuid");
  });

  it("trace_id is nullable varchar(100)", () => {
    const col = table.columns.find((c) => c.name === "trace_id");
    expect(col?.notNull).toBe(false);
    expect(col?.getSQLType()).toBe("varchar(100)");
  });

  it("created_at defaults to NOW()", () => {
    const col = table.columns.find((c) => c.name === "created_at");
    expect(col?.notNull).toBe(true);
    expect(col?.hasDefault).toBe(true);
  });

  it("retry_count is NOT NULL smallint defaulting to 0", () => {
    const col = table.columns.find((c) => c.name === "retry_count");
    expect(col?.notNull).toBe(true);
    expect(col?.getSQLType()).toBe("smallint");
    expect(col?.hasDefault).toBe(true);
  });

  it("status is NOT NULL varchar(40)", () => {
    const col = table.columns.find((c) => c.name === "status");
    expect(col?.notNull).toBe(true);
    expect(col?.getSQLType()).toBe("varchar(40)");
  });

  it("resolution_action / resolution_source / resolved_at / resolved_by / resolution_notes are nullable", () => {
    for (const name of [
      "resolution_action",
      "resolution_source",
      "resolved_at",
      "resolved_by",
      "resolution_notes",
    ]) {
      const col = table.columns.find((c) => c.name === name);
      expect(col, `column ${name}`).toBeDefined();
      expect(col?.notNull, `${name} must be nullable`).toBe(false);
    }
  });

  it("declares the six ERD-spec'd indexes", () => {
    const names = table.indexes.map((i) => i.config.name).sort();
    expect(names).toEqual([
      "idx_offline_queue_idempotency",
      "idx_offline_queue_participant",
      "idx_offline_queue_resolution_source",
      "idx_offline_queue_specialist",
      "idx_offline_queue_status",
      "idx_offline_queue_trace_id",
    ]);
  });

  it("declares the four CHECK constraints", () => {
    const names = table.checks.map((c) => c.name).sort();
    expect(names).toEqual([
      "offline_queue_resolution_action_check",
      "offline_queue_resolution_source_check",
      "offline_queue_retry_count_check",
      "offline_queue_status_check",
    ]);
  });

  it("declares the FK to idempotency_keys(key) with ON DELETE SET NULL", () => {
    expect(table.foreignKeys).toHaveLength(1);
    const fk = table.foreignKeys[0]!;
    expect(fk.onDelete).toBe("set null");
    const ref = fk.reference();
    expect(getTableName(ref.foreignTable)).toBe("idempotency_keys");
    expect(ref.foreignColumns.map((c) => c.name)).toEqual(["key"]);
    expect(ref.columns.map((c) => c.name)).toEqual(["idempotency_key"]);
  });

  it("exported union types cover the full TR-OFFLINE-5a state vocabulary", () => {
    // Compile-time assertion — exhaustiveness is enforced by the switch.
    const statusCases: Record<OfflineQueueStatus, true> = {
      pending_sync: true,
      in_flight: true,
      completed: true,
      review_required_reassigned: true,
      review_required_terminated: true,
      failed_max_retries: true,
      discarded: true,
    };
    expect(Object.keys(statusCases)).toHaveLength(7);

    const actionCases: Record<ResolutionAction, true> = {
      DISCARD: true,
      REASSIGN_RETRY: true,
      ESCALATE_TO_SUPERVISOR: true,
    };
    expect(Object.keys(actionCases)).toHaveLength(3);

    const sourceCases: Record<ResolutionSource, true> = {
      auto_retry: true,
      auto_max_retries: true,
      auto_lock_retry: true,
      specialist: true,
      supervisor: true,
      system: true,
    };
    expect(Object.keys(sourceCases)).toHaveLength(6);
  });
});
