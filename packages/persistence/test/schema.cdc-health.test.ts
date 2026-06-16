import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { cdcHealth } from "../src/schema/index.js";

// Drift sentinel for the P1C-03 `cdc_health` schema (ERD §6.9). Keep in lockstep
// with migration 0008 and the ERD entry; a change to either MUST update this
// test or it will fail in CI.

describe("schema: cdc_health (P1C-03, ERD §6.9)", () => {
  const table = getTableConfig(cdcHealth);

  it("declares exactly 10 columns", () => {
    expect(table.columns).toHaveLength(10);
  });

  it("id is uuid PK with gen_random_uuid() default", () => {
    const id = table.columns.find((c) => c.name === "id");
    expect(id?.primary).toBe(true);
    expect(id?.notNull).toBe(true);
    expect(id?.getSQLType()).toBe("uuid");
    expect(id?.hasDefault).toBe(true);
  });

  it("worker_id is NOT NULL varchar(100)", () => {
    const col = table.columns.find((c) => c.name === "worker_id");
    expect(col?.notNull).toBe(true);
    expect(col?.getSQLType()).toBe("varchar(100)");
  });

  it("last_heartbeat_at + updated_at default to NOW()", () => {
    const heartbeat = table.columns.find((c) => c.name === "last_heartbeat_at");
    const updated = table.columns.find((c) => c.name === "updated_at");
    expect(heartbeat?.notNull).toBe(true);
    expect(heartbeat?.hasDefault).toBe(true);
    expect(updated?.notNull).toBe(true);
    expect(updated?.hasDefault).toBe(true);
  });

  it("last_event_id, last_event_received_at, replay_id are nullable", () => {
    for (const name of ["last_event_id", "last_event_received_at", "replay_id"]) {
      const col = table.columns.find((c) => c.name === name);
      expect(col, `column ${name}`).toBeDefined();
      expect(col?.notNull, `${name} must be nullable`).toBe(false);
    }
  });

  it("subscription_status defaults to 'CONNECTED'", () => {
    const col = table.columns.find((c) => c.name === "subscription_status");
    expect(col?.notNull).toBe(true);
    expect(col?.getSQLType()).toBe("varchar(30)");
    expect(col?.hasDefault).toBe(true);
  });

  it("subscription_states is NOT NULL jsonb with '{}' default", () => {
    const col = table.columns.find((c) => c.name === "subscription_states");
    expect(col?.notNull).toBe(true);
    expect(col?.getSQLType()).toBe("jsonb");
    expect(col?.hasDefault).toBe(true);
  });

  it("error_count_24h is NOT NULL smallint defaulting to 0", () => {
    const col = table.columns.find((c) => c.name === "error_count_24h");
    expect(col?.notNull).toBe(true);
    expect(col?.getSQLType()).toBe("smallint");
    expect(col?.hasDefault).toBe(true);
  });

  it("declares the two ERD-spec'd indexes", () => {
    const names = table.indexes.map((i) => i.config.name).sort();
    expect(names).toEqual(["idx_cdc_health_status", "idx_cdc_health_worker"]);
  });

  it("declares the two CHECK constraints", () => {
    const names = table.checks.map((c) => c.name).sort();
    expect(names).toEqual([
      "cdc_health_subscription_status_check",
      "cdc_health_worker_id_check",
    ]);
  });
});
