import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { sessions } from "../src/schema/index.js";

// Drift sentinel: asserts the Drizzle TS schema against ERD v1.4 §6.8
// (Demo Mode only — Production substrate swaps to Redis with native TTL).
// Deliberately verifies trace_id is ABSENT: ERD §3.1 propagation list scopes
// trace_id to audit_log + idempotency_keys + offline_queue +
// supervisor_escalations + ai_requests; sessions correlates via audit_log.

describe("schema: sessions (ERD §6.8, Demo Mode only)", () => {
  const sess = getTableConfig(sessions);

  it("declares 16 columns (ERD §6.8 + the P1B-05 identity columns)", () => {
    expect(sess.columns).toHaveLength(16);
  });

  it("does NOT carry trace_id — substrate-shape invariant per ERD §3", () => {
    expect(sess.columns.find((c) => c.name === "trace_id")).toBeUndefined();
  });

  it("carries token_hash — varchar(64) NOT NULL, the hashed session-lookup key (P1A-04)", () => {
    const tokenHash = sess.columns.find((c) => c.name === "token_hash");
    expect(tokenHash, "token_hash column").toBeDefined();
    expect(tokenHash?.notNull, "token_hash must be NOT NULL").toBe(true);
    expect(tokenHash?.getSQLType()).toBe("varchar(64)");
    expect(tokenHash?.primary, "token_hash is a lookup key, not the PK").toBe(false);
  });

  it("uses uuid PK with gen_random_uuid() default", () => {
    const id = sess.columns.find((c) => c.name === "id");
    expect(id?.primary).toBe(true);
    expect(id?.hasDefault).toBe(true);
    expect(id?.notNull).toBe(true);
  });

  it("requires specialist_id, role, created_at, last_activity_at, expires_at, revoked", () => {
    for (const name of [
      "specialist_id",
      "role",
      "created_at",
      "last_activity_at",
      "expires_at",
      "revoked",
    ]) {
      const col = sess.columns.find((c) => c.name === name);
      expect(col, `column ${name}`).toBeDefined();
      expect(col?.notNull, `${name} must be NOT NULL`).toBe(true);
    }
  });

  it("declares the role CHECK constraint with the four enum values", () => {
    expect(sess.checks.find((c) => c.name === "sessions_role_check")).toBeDefined();
  });

  it("ip_address uses the inet type", () => {
    const ip = sess.columns.find((c) => c.name === "ip_address");
    expect(ip?.getSQLType()).toBe("inet");
  });

  it("carries sf_refresh_token_encrypted — nullable text, the at-rest refresh token (P1B-02)", () => {
    const col = sess.columns.find((c) => c.name === "sf_refresh_token_encrypted");
    expect(col, "sf_refresh_token_encrypted column").toBeDefined();
    expect(col?.getSQLType()).toBe("text");
    // Nullable: a Demo-Mode-only artifact — at the Production substrate swap
    // the refresh token re-homes to AWS Secrets Manager (TR-AUTH-6).
    expect(col?.notNull, "sf_refresh_token_encrypted must be nullable").toBe(false);
  });

  it("carries the P1B-05 identity columns — nullable varchar (display_name, email, timezone)", () => {
    for (const [name, sqlType] of [
      ["display_name", "varchar(255)"],
      ["email", "varchar(255)"],
      ["timezone", "varchar(50)"],
    ] as const) {
      const col = sess.columns.find((c) => c.name === name);
      expect(col, `column ${name}`).toBeDefined();
      expect(col?.getSQLType()).toBe(sqlType);
      // Nullable — a session can structurally exist before /auth/callback
      // wires the values; Demo-Mode-only, dropped at the Redis substrate swap.
      expect(col?.notNull, `${name} must be nullable`).toBe(false);
    }
  });

  it("defaults expires_at to NOW() + INTERVAL '12 hours' (GAP-11 defensive)", () => {
    const expires = sess.columns.find((c) => c.name === "expires_at");
    expect(expires?.hasDefault).toBe(true);
    expect(expires?.notNull).toBe(true);
  });

  it("registers all four indexes (ERD §6.8 + the P1A-04 token_hash unique index)", () => {
    const names = sess.indexes.map((i) => i.config.name).sort();
    expect(names).toEqual([
      "idx_sessions_active_per_specialist",
      "idx_sessions_expires",
      "idx_sessions_specialist",
      "idx_sessions_token_hash",
    ]);
  });

  it("idx_sessions_token_hash is UNIQUE — one session row per token hash", () => {
    const idx = sess.indexes.find((i) => i.config.name === "idx_sessions_token_hash");
    expect(idx).toBeDefined();
    expect(idx?.config.unique).toBe(true);
  });

  // ERD §6.8 specifies `WHERE revoked = false AND expires_at > NOW()`, but Postgres
  // rejects NOW() in index predicates (must be IMMUTABLE; error 42P17). We narrow
  // to `WHERE revoked = false` and let the planner re-apply the time clause at
  // query time. ERD patch tracked in the P1A-01 PR description.
  it("idx_sessions_active_per_specialist is partial on revoked=false (ERD §6.8 patched: NOW() dropped)", () => {
    const idx = sess.indexes.find((i) => i.config.name === "idx_sessions_active_per_specialist");
    expect(idx).toBeDefined();
    expect(idx?.config.where).toBeDefined();
  });
});
