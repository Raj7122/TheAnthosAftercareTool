import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { caseloadCache } from "../src/schema/index.js";

// Drift sentinel: asserts the Drizzle TS schema for the P1C-02 `caseload_cache`
// table (Demo-Mode server-side cache for engine-scored caseload payloads)
// against migration 0007. Keep in lockstep with 0007_add_caseload_cache.sql.

describe("schema: caseload_cache (P1C-02, F-02/F-04)", () => {
  const table = getTableConfig(caseloadCache);

  it("declares exactly 6 columns", () => {
    expect(table.columns).toHaveLength(6);
  });

  it("keys on the composite {specialist_id, queue_id, config_version}", () => {
    expect(table.primaryKeys).toHaveLength(1);
    const pkColumns = table.primaryKeys[0]?.columns.map((c) => c.name);
    expect(pkColumns).toEqual(["specialist_id", "queue_id", "config_version"]);
    // No column carries a single-column inline PK — the key is composite.
    expect(table.columns.every((c) => !c.primary)).toBe(true);
  });

  it("the three key columns are NOT NULL with the expected types", () => {
    const types: Record<string, string> = {
      specialist_id: "varchar(50)",
      queue_id: "varchar(100)",
      config_version: "integer",
    };
    for (const [name, sqlType] of Object.entries(types)) {
      const col = table.columns.find((c) => c.name === name);
      expect(col, `column ${name}`).toBeDefined();
      expect(col?.notNull, `${name} must be NOT NULL`).toBe(true);
      expect(col?.getSQLType(), `${name} type`).toBe(sqlType);
    }
  });

  it("payload is a NOT NULL jsonb column", () => {
    const payload = table.columns.find((c) => c.name === "payload");
    expect(payload?.notNull).toBe(true);
    expect(payload?.getSQLType()).toBe("jsonb");
  });

  it("last_refreshed_at is NOT NULL with a NOW() default", () => {
    const ts = table.columns.find((c) => c.name === "last_refreshed_at");
    expect(ts?.notNull).toBe(true);
    expect(ts?.hasDefault).toBe(true);
  });

  it("freshness_window_seconds is a NOT NULL integer with no default", () => {
    const col = table.columns.find((c) => c.name === "freshness_window_seconds");
    expect(col?.notNull).toBe(true);
    expect(col?.getSQLType()).toBe("integer");
    expect(col?.hasDefault).toBe(false);
  });

  it("declares the two invalidation-path indexes", () => {
    const names = table.indexes.map((i) => i.config.name).sort();
    expect(names).toEqual([
      "idx_caseload_cache_config_version",
      "idx_caseload_cache_queue",
    ]);
  });

  it("declares the four CHECK constraints", () => {
    const names = table.checks.map((c) => c.name).sort();
    expect(names).toEqual([
      "caseload_cache_config_version_check",
      "caseload_cache_freshness_window_check",
      "caseload_cache_queue_id_check",
      "caseload_cache_specialist_id_check",
    ]);
  });
});
