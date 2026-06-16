import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { configuration, configurationAudit } from "../src/schema/index.js";

// These tests assert the Drizzle TS schema against ERD v1.4 §6.6 / §6.7
// without needing a live DB. They are the drift sentinel until the
// integration test harness lands in P1A-01.

describe("schema: configuration (ERD §6.6)", () => {
  const cfg = getTableConfig(configuration);

  // ERD §6.6 baseline = 39 columns. P0-04a (migration 0001) adds
  // `tier_invariants` jsonb for BR-24/25/26 invariant config → 40. P1E-03
  // (migration 0009) adds five columns for BR-19(e) / BR-37 severity weights
  // + BR-39 staleness controls → 45. P0-14 (migration 0012) adds
  // `days_since_contact_scoring_cap_days` for the BR-19(a) scoring cap → 46.
  it("declares 46 columns (ERD §6.6 + tier_invariants + P1E-03 severity/staleness + P0-14 cap)", () => {
    expect(cfg.columns).toHaveLength(46);
  });

  it("has version as primary key", () => {
    const version = cfg.columns.find((c) => c.name === "version");
    expect(version?.primary).toBe(true);
    expect(version?.notNull).toBe(true);
  });

  it("requires sbop_path with a CHECK constraint", () => {
    const sbop = cfg.columns.find((c) => c.name === "sbop_path");
    expect(sbop?.notNull).toBe(true);
    expect(sbop?.hasDefault).toBe(false);
    const check = cfg.checks.find((c) => c.name === "configuration_sbop_path_check");
    expect(check).toBeDefined();
  });

  it("enforces the partial unique index on is_active = true", () => {
    const partial = cfg.indexes.find((i) => i.config.name === "idx_configuration_active");
    expect(partial).toBeDefined();
    expect(partial?.config.unique).toBe(true);
  });

  it("defaults jsonb columns per ERD", () => {
    const backoff = cfg.columns.find((c) => c.name === "mogli_backoff_seconds");
    const flags = cfg.columns.find((c) => c.name === "feature_flags");
    expect(backoff?.hasDefault).toBe(true);
    expect(backoff?.notNull).toBe(true);
    expect(flags?.hasDefault).toBe(true);
    expect(flags?.notNull).toBe(true);
  });

  it("defaults calibration thresholds per ERD §6.6", () => {
    const threshold = cfg.columns.find((c) => c.name === "calibration_threshold_pct");
    expect(threshold?.hasDefault).toBe(true);
    expect(threshold?.notNull).toBe(true);
  });
});

describe("schema: configuration_audit (ERD §6.7)", () => {
  const audit = getTableConfig(configurationAudit);

  it("declares 10 columns matching ERD §6.7", () => {
    expect(audit.columns).toHaveLength(10);
  });

  it("uses uuid PK with gen_random_uuid() default", () => {
    const id = audit.columns.find((c) => c.name === "id");
    expect(id?.primary).toBe(true);
    expect(id?.hasDefault).toBe(true);
  });

  it("requires actor_id, field_path, new_value, reason, version_to", () => {
    const required = ["actor_id", "field_path", "new_value", "reason", "version_to"];
    for (const name of required) {
      const col = audit.columns.find((c) => c.name === name);
      expect(col, `column ${name}`).toBeDefined();
      expect(col?.notNull, `${name} must be NOT NULL`).toBe(true);
    }
  });

  it("declares both FKs back to configuration(version)", () => {
    expect(audit.foreignKeys).toHaveLength(2);
  });

  it("registers the four indexes from ERD §6.7", () => {
    const names = audit.indexes.map((i) => i.config.name).sort();
    expect(names).toEqual([
      "idx_config_audit_actor",
      "idx_config_audit_field",
      "idx_config_audit_timestamp",
      "idx_config_audit_version_to",
    ]);
  });
});
