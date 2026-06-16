import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// Hits a real Postgres (Supabase/Neon) via DEMO_POSTGRES_URL. This is the
// round-trip proof for the atomic `INSERT … ON CONFLICT DO UPDATE … WHERE`
// check-and-consume: concurrent same-key requests must resolve to exactly one
// winner. Skipped when DEMO_POSTGRES_URL is unset so CI stays green.

const RUN = !!process.env.DEMO_POSTGRES_URL;

describe.skipIf(!RUN)("rate-limits repository (integration)", () => {
  // Lazy-imported so client.ts (which throws on missing DEMO_POSTGRES_URL)
  // never evaluates when the suite is skipped.
  let db: (typeof import("../../src/db/client.js"))["db"];
  let closeDb: (typeof import("../../src/db/client.js"))["closeDb"];
  let repo: typeof import("../../src/repositories/index.js");

  beforeAll(async () => {
    ({ db, closeDb } = await import("../../src/db/client.js"));
    repo = await import("../../src/repositories/index.js");
  });

  afterAll(async () => {
    await closeDb();
  });

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE TABLE rate_limits`);
  });

  it("allows the first request for a never-seen key", async () => {
    expect(await repo.checkAndConsumeRateLimit(db, "auth.refresh:S-1", 5)).toBe(
      true,
    );
  });

  it("throttles a second request inside the window", async () => {
    expect(await repo.checkAndConsumeRateLimit(db, "auth.refresh:S-1", 5)).toBe(
      true,
    );
    expect(await repo.checkAndConsumeRateLimit(db, "auth.refresh:S-1", 5)).toBe(
      false,
    );
  });

  it("allows again once the window has elapsed", async () => {
    await repo.checkAndConsumeRateLimit(db, "auth.refresh:S-1", 5);
    await db.execute(
      sql`UPDATE rate_limits SET last_request_at = NOW() - INTERVAL '10 seconds' WHERE key = 'auth.refresh:S-1'`,
    );
    expect(await repo.checkAndConsumeRateLimit(db, "auth.refresh:S-1", 5)).toBe(
      true,
    );
  });

  it("isolates the window per key", async () => {
    expect(await repo.checkAndConsumeRateLimit(db, "auth.refresh:S-1", 5)).toBe(
      true,
    );
    expect(await repo.checkAndConsumeRateLimit(db, "auth.refresh:S-2", 5)).toBe(
      true,
    );
  });

  it("resolves concurrent requests for one key to exactly one winner", async () => {
    const results = await Promise.all([
      repo.checkAndConsumeRateLimit(db, "auth.refresh:S-9", 5),
      repo.checkAndConsumeRateLimit(db, "auth.refresh:S-9", 5),
      repo.checkAndConsumeRateLimit(db, "auth.refresh:S-9", 5),
    ]);
    expect(results.filter((allowed) => allowed)).toHaveLength(1);
  });
});
