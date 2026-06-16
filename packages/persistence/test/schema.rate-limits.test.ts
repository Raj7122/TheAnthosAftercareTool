import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { rateLimits } from "../src/schema/index.js";

// Drift sentinel: asserts the Drizzle TS schema for the P1B-03 `rate_limits`
// table (ERD v1.4 patch — Demo-Mode application-level rate-limit substrate).

describe("schema: rate_limits (ERD v1.4 patch, P1B-03)", () => {
  const table = getTableConfig(rateLimits);

  it("declares exactly 2 columns", () => {
    expect(table.columns).toHaveLength(2);
  });

  it("uses key as the varchar(150) primary key with NO default", () => {
    const key = table.columns.find((c) => c.name === "key");
    expect(key?.primary).toBe(true);
    expect(key?.notNull).toBe(true);
    expect(key?.hasDefault).toBe(false);
  });

  it("last_request_at is NOT NULL with a NOW() default", () => {
    const ts = table.columns.find((c) => c.name === "last_request_at");
    expect(ts?.notNull).toBe(true);
    expect(ts?.hasDefault).toBe(true);
  });

  it("declares no secondary indexes — the PK is the only access path", () => {
    expect(table.indexes).toHaveLength(0);
  });
});
