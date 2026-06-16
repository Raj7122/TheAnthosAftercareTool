import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// Hits a real Postgres (Supabase/Neon) via DEMO_POSTGRES_URL. Round-trip proof
// for the P1C-02 cache contract: get/set/invalidate and the freshness-state
// resolution (fresh | stale | miss) — freshness is computed in Postgres, so
// this suite is the resolution test. Skipped when DEMO_POSTGRES_URL is unset so
// CI stays green. Also exercises migration 0007 (the table must exist to run).

const RUN = !!process.env.DEMO_POSTGRES_URL;

// Engine-scored caseload payload — PII-free: SF record IDs + derived scores
// only (Immutable #1 / TR-PRIORITY-1). The repository treats it opaquely.
interface ScoredRow {
  participantId: string;
  tier: number;
  priorityScore: number;
}
const payloadA: ScoredRow[] = [
  { participantId: "a0X00000000000001", tier: 1, priorityScore: 92 },
  { participantId: "a0X00000000000002", tier: 3, priorityScore: 41 },
];
const payloadB: ScoredRow[] = [
  { participantId: "a0X00000000000003", tier: 2, priorityScore: 67 },
];

describe.skipIf(!RUN)("caseload-cache repository (integration)", () => {
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
    await db.execute(sql`TRUNCATE TABLE caseload_cache`);
  });

  const key = { specialistId: "S-1", queueId: "due-today", configVersion: 1 };

  it("get returns a miss for a never-cached key", async () => {
    const result = await repo.getCaseloadCache(db, key);
    expect(result.freshness).toBe("miss");
    expect(result.payload).toBeNull();
    expect(result.lastRefreshedAt).toBeNull();
  });

  it("set then get returns the payload as fresh", async () => {
    await repo.setCaseloadCache<ScoredRow[]>(db, { ...key, payload: payloadA });
    const result = await repo.getCaseloadCache<ScoredRow[]>(db, key);
    expect(result.freshness).toBe("fresh");
    expect(result.payload).toEqual(payloadA);
    expect(result.lastRefreshedAt).toBeInstanceOf(Date);
  });

  it("get returns stale once the freshness window has elapsed", async () => {
    await repo.setCaseloadCache<ScoredRow[]>(db, { ...key, payload: payloadA });
    // Push last_refreshed_at well past the default 60s window.
    await db.execute(
      sql`UPDATE caseload_cache SET last_refreshed_at = NOW() - INTERVAL '2 hours'`,
    );
    const result = await repo.getCaseloadCache<ScoredRow[]>(db, key);
    expect(result.freshness).toBe("stale");
    // Payload is still returned for a stale row — only a miss is null.
    expect(result.payload).toEqual(payloadA);
  });

  it("honors a per-write freshness window override", async () => {
    await repo.setCaseloadCache<ScoredRow[]>(db, {
      ...key,
      payload: payloadA,
      freshnessWindowSeconds: 1,
    });
    await db.execute(
      sql`UPDATE caseload_cache SET last_refreshed_at = NOW() - INTERVAL '5 seconds'`,
    );
    const result = await repo.getCaseloadCache<ScoredRow[]>(db, key);
    expect(result.freshness).toBe("stale");
  });

  it("set is an idempotent upsert — overwrites in place, no duplicate row", async () => {
    await repo.setCaseloadCache<ScoredRow[]>(db, { ...key, payload: payloadA });
    const first = await repo.getCaseloadCache<ScoredRow[]>(db, key);
    await repo.setCaseloadCache<ScoredRow[]>(db, { ...key, payload: payloadB });

    const result = await repo.getCaseloadCache<ScoredRow[]>(db, key);
    expect(result.freshness).toBe("fresh");
    expect(result.payload).toEqual(payloadB);
    // last_refreshed_at advanced (or held) — never moved backwards.
    expect(result.lastRefreshedAt!.getTime()).toBeGreaterThanOrEqual(
      first.lastRefreshedAt!.getTime(),
    );
    // A single deleted row proves the upsert did not append a duplicate.
    const deleted = await repo.invalidateCaseloadCache(db, {
      kind: "specialist",
      specialistId: key.specialistId,
    });
    expect(deleted).toBe(1);
  });

  it("set isolates the cache key triple", async () => {
    await repo.setCaseloadCache<ScoredRow[]>(db, { ...key, payload: payloadA });
    // Same specialist + queue, different config version — a distinct row.
    const bumped = { ...key, configVersion: 2 };
    expect((await repo.getCaseloadCache(db, bumped)).freshness).toBe("miss");
    await repo.setCaseloadCache<ScoredRow[]>(db, { ...bumped, payload: payloadB });
    expect((await repo.getCaseloadCache<ScoredRow[]>(db, key)).payload).toEqual(
      payloadA,
    );
    expect(
      (await repo.getCaseloadCache<ScoredRow[]>(db, bumped)).payload,
    ).toEqual(payloadB);
  });

  it("invalidate by specialist evicts every queue for that specialist only", async () => {
    await repo.setCaseloadCache<ScoredRow[]>(db, { ...key, payload: payloadA });
    await repo.setCaseloadCache<ScoredRow[]>(db, {
      specialistId: "S-1",
      queueId: "overdue",
      configVersion: 1,
      payload: payloadB,
    });
    await repo.setCaseloadCache<ScoredRow[]>(db, {
      specialistId: "S-2",
      queueId: "due-today",
      configVersion: 1,
      payload: payloadB,
    });

    const deleted = await repo.invalidateCaseloadCache(db, {
      kind: "specialist",
      specialistId: "S-1",
    });
    expect(deleted).toBe(2);
    expect((await repo.getCaseloadCache(db, key)).freshness).toBe("miss");
    // S-2 is untouched.
    expect(
      (
        await repo.getCaseloadCache(db, {
          specialistId: "S-2",
          queueId: "due-today",
          configVersion: 1,
        })
      ).freshness,
    ).toBe("fresh");
  });

  it("invalidate by queue evicts that queue across all specialists", async () => {
    await repo.setCaseloadCache<ScoredRow[]>(db, { ...key, payload: payloadA });
    await repo.setCaseloadCache<ScoredRow[]>(db, {
      specialistId: "S-2",
      queueId: "due-today",
      configVersion: 1,
      payload: payloadB,
    });
    await repo.setCaseloadCache<ScoredRow[]>(db, {
      specialistId: "S-1",
      queueId: "overdue",
      configVersion: 1,
      payload: payloadB,
    });

    const deleted = await repo.invalidateCaseloadCache(db, {
      kind: "queue",
      queueId: "due-today",
    });
    expect(deleted).toBe(2);
    expect(
      (
        await repo.getCaseloadCache(db, {
          specialistId: "S-1",
          queueId: "overdue",
          configVersion: 1,
        })
      ).freshness,
    ).toBe("fresh");
  });

  it("invalidate by config version evicts that cohort", async () => {
    await repo.setCaseloadCache<ScoredRow[]>(db, { ...key, payload: payloadA });
    await repo.setCaseloadCache<ScoredRow[]>(db, {
      ...key,
      configVersion: 2,
      payload: payloadB,
    });

    const deleted = await repo.invalidateCaseloadCache(db, {
      kind: "configVersion",
      configVersion: 1,
    });
    expect(deleted).toBe(1);
    expect((await repo.getCaseloadCache(db, key)).freshness).toBe("miss");
    expect(
      (await repo.getCaseloadCache(db, { ...key, configVersion: 2 })).freshness,
    ).toBe("fresh");
  });

  it("invalidate by specialistQueue evicts exactly one {specialist, queue} pair", async () => {
    await repo.setCaseloadCache<ScoredRow[]>(db, { ...key, payload: payloadA });
    await repo.setCaseloadCache<ScoredRow[]>(db, {
      ...key,
      configVersion: 2,
      payload: payloadB,
    });
    await repo.setCaseloadCache<ScoredRow[]>(db, {
      specialistId: "S-1",
      queueId: "overdue",
      configVersion: 1,
      payload: payloadB,
    });

    const deleted = await repo.invalidateCaseloadCache(db, {
      kind: "specialistQueue",
      specialistId: "S-1",
      queueId: "due-today",
    });
    // Both config versions of the {S-1, due-today} pair, not the overdue queue.
    expect(deleted).toBe(2);
    expect(
      (
        await repo.getCaseloadCache(db, {
          specialistId: "S-1",
          queueId: "overdue",
          configVersion: 1,
        })
      ).freshness,
    ).toBe("fresh");
  });

  it("invalidate returns 0 when nothing matches the scope", async () => {
    const deleted = await repo.invalidateCaseloadCache(db, {
      kind: "specialist",
      specialistId: "nobody",
    });
    expect(deleted).toBe(0);
  });
});
