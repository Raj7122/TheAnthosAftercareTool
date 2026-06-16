import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { notificationPreferences } from "../src/schema/index.js";

// Drift sentinel: asserts the Drizzle TS schema against ERD v1.4 §6.11
// (per-specialist preferences + per-session state; UPSERT by specialist_id PK).

describe("schema: notification_preferences (ERD §6.11)", () => {
  const prefs = getTableConfig(notificationPreferences);

  it("declares 13 columns matching ERD §6.11", () => {
    expect(prefs.columns).toHaveLength(13);
  });

  it("uses specialist_id as the primary key", () => {
    const sid = prefs.columns.find((c) => c.name === "specialist_id");
    expect(sid?.primary).toBe(true);
    expect(sid?.notNull).toBe(true);
  });

  it("digest_send_local_time is `time` without timezone, default '08:00:00'", () => {
    const t = prefs.columns.find((c) => c.name === "digest_send_local_time");
    expect(t?.getSQLType()).toBe("time");
    expect(t?.hasDefault).toBe(true);
    expect(t?.notNull).toBe(true);
  });

  it("defaults timezone to America/New_York", () => {
    const tz = prefs.columns.find((c) => c.name === "timezone");
    expect(tz?.hasDefault).toBe(true);
    expect(tz?.notNull).toBe(true);
  });

  it("defaults last_seen_tier_1_participant_ids to '[]'::jsonb", () => {
    const seen = prefs.columns.find((c) => c.name === "last_seen_tier_1_participant_ids");
    expect(seen?.hasDefault).toBe(true);
    expect(seen?.notNull).toBe(true);
  });

  it("registers all three partial indexes on boolean flags", () => {
    const names = prefs.indexes.map((i) => i.config.name).sort();
    expect(names).toEqual([
      "idx_notif_prefs_daily",
      "idx_notif_prefs_first_run",
      "idx_notif_prefs_weekly",
    ]);
    for (const idx of prefs.indexes) {
      expect(idx.config.where, `${idx.config.name} must be a partial index`).toBeDefined();
    }
  });

  it("first-run flag defaults to false so the first-login experience triggers once", () => {
    const fr = prefs.columns.find((c) => c.name === "first_run_completed");
    expect(fr?.hasDefault).toBe(true);
    expect(fr?.notNull).toBe(true);
  });
});
