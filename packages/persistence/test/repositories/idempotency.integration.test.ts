import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// Hits a real Postgres (Supabase/Neon) via DEMO_POSTGRES_URL. This is the
// round-trip proof for TR-WRITE-2b's atomic lock: `INSERT … ON CONFLICT (key)
// DO NOTHING RETURNING *` must resolve concurrent same-key inserts to exactly
// one winner. Skipped when DEMO_POSTGRES_URL is unset so CI stays green.

const RUN = !!process.env.DEMO_POSTGRES_URL;

function lockInput(key: string) {
  return {
    key,
    specialistId: "S-INT",
    endpoint: "POST /api/calls",
    requestHash: "a".repeat(64),
    traceId: randomUUID(),
  };
}

describe.skipIf(!RUN)("idempotency repository (integration)", () => {
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
    await db.execute(sql`TRUNCATE TABLE idempotency_keys`);
  });

  it("acquires a lock and reads it back as IN_FLIGHT with a future TTL", async () => {
    const key = randomUUID();
    const acquired = await repo.acquireIdempotencyLock(db, lockInput(key));
    expect(acquired).not.toBeNull();
    expect(acquired?.status).toBe("IN_FLIGHT");

    const fetched = await repo.getIdempotencyKey(db, key);
    expect(fetched?.key).toBe(key);
    expect(fetched?.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("returns null on a second acquire of the same key (ON CONFLICT DO NOTHING)", async () => {
    const key = randomUUID();
    const first = await repo.acquireIdempotencyLock(db, lockInput(key));
    const second = await repo.acquireIdempotencyLock(db, lockInput(key));
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it("resolves concurrent acquires of the same key to exactly one winner", async () => {
    const key = randomUUID();
    const results = await Promise.all([
      repo.acquireIdempotencyLock(db, lockInput(key)),
      repo.acquireIdempotencyLock(db, lockInput(key)),
      repo.acquireIdempotencyLock(db, lockInput(key)),
    ]);
    expect(results.filter((row) => row !== null)).toHaveLength(1);
  });

  it("markIdempotencyCompleted transitions the row and caches the response", async () => {
    const key = randomUUID();
    await repo.acquireIdempotencyLock(db, lockInput(key));
    await repo.markIdempotencyCompleted(db, key, 201, { id: "call-1" });

    const row = await repo.getIdempotencyKey(db, key);
    expect(row?.status).toBe("COMPLETED");
    expect(row?.responseStatusCode).toBe(201);
    expect(row?.responseBody).toEqual({ id: "call-1" });
    expect(row?.completedAt).not.toBeNull();
  });

  it("markIdempotencyFailedTerminal transitions the row to FAILED_TERMINAL", async () => {
    const key = randomUUID();
    await repo.acquireIdempotencyLock(db, lockInput(key));
    await repo.markIdempotencyFailedTerminal(db, key, 422, {
      code: "VALIDATION_FAILED",
    });

    const row = await repo.getIdempotencyKey(db, key);
    expect(row?.status).toBe("FAILED_TERMINAL");
    expect(row?.responseStatusCode).toBe(422);
  });

  it("deleteIdempotencyKey releases the lock", async () => {
    const key = randomUUID();
    await repo.acquireIdempotencyLock(db, lockInput(key));
    await repo.deleteIdempotencyKey(db, key);
    expect(await repo.getIdempotencyKey(db, key)).toBeNull();
  });

  it("cleanupExpiredIdempotencyKeys deletes only rows past their TTL", async () => {
    const expiredKey = randomUUID();
    const liveKey = randomUUID();
    await repo.acquireIdempotencyLock(db, lockInput(expiredKey));
    await repo.acquireIdempotencyLock(db, lockInput(liveKey));
    await db.execute(
      sql`UPDATE idempotency_keys SET expires_at = NOW() - INTERVAL '1 hour' WHERE key = ${expiredKey}`,
    );

    const deleted = await repo.cleanupExpiredIdempotencyKeys(db);
    expect(deleted).toBe(1);
    expect(await repo.getIdempotencyKey(db, expiredKey)).toBeNull();
    expect(await repo.getIdempotencyKey(db, liveKey)).not.toBeNull();
  });
});
