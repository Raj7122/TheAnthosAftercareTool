import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// Hits a real Postgres via DEMO_POSTGRES_URL. Round-trip proof for the
// `getPendingForSpecialist` repository contract (P3C-05, E-17): per-specialist
// scoping, terminal-status exclusion, per-status counts, and the TR-OFFLINE-7
// ≤100 row cap. Skipped when DEMO_POSTGRES_URL is unset so CI stays green.
// Requires migration 0010_add_offline_queue.

const RUN = !!process.env.DEMO_POSTGRES_URL;

describe.skipIf(!RUN)("offline-queue repository (integration)", () => {
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
    await db.execute(sql`TRUNCATE TABLE offline_queue`);
  });

  // Inserts an offline_queue row with sensible defaults; overrides win.
  async function insertRow(overrides: {
    specialistId: string;
    status:
      | "pending_sync"
      | "in_flight"
      | "completed"
      | "review_required_reassigned"
      | "review_required_terminated"
      | "failed_max_retries"
      | "discarded";
    createdAt?: Date;
    payload?: unknown;
    errorDetails?: unknown;
  }): Promise<string> {
    const id = randomUUID();
    const createdAt = overrides.createdAt ?? new Date();
    await db.execute(sql`
      INSERT INTO offline_queue (
        id, specialist_id, action_type, payload, status, created_at, retry_count, error_details
      ) VALUES (
        ${id}::uuid,
        ${overrides.specialistId},
        ${"call.logged"},
        ${JSON.stringify(overrides.payload ?? { status: "Completed" })}::jsonb,
        ${overrides.status},
        ${createdAt.toISOString()}::timestamptz,
        0,
        ${overrides.errorDetails ? JSON.stringify(overrides.errorDetails) : null}::jsonb
      )
    `);
    return id;
  }

  it("returns only the caller's rows", async () => {
    await insertRow({ specialistId: "S-1", status: "pending_sync" });
    await insertRow({ specialistId: "S-2", status: "pending_sync" });
    await insertRow({ specialistId: "S-2", status: "in_flight" });

    const result = await repo.getPendingForSpecialist(db, "S-1");
    expect(result.rows).toHaveLength(1);
    expect(result.rows.every((row) => row.specialistId === "S-1")).toBe(true);
  });

  it("excludes `completed` and `discarded` rows from items + counts + depth", async () => {
    await insertRow({ specialistId: "S-1", status: "pending_sync" });
    await insertRow({ specialistId: "S-1", status: "completed" });
    await insertRow({ specialistId: "S-1", status: "discarded" });
    await insertRow({ specialistId: "S-1", status: "review_required_reassigned" });

    const result = await repo.getPendingForSpecialist(db, "S-1");
    expect(result.rows).toHaveLength(2);
    expect(result.queueDepth).toBe(2);
    expect(result.counts.pending_sync).toBe(1);
    expect(result.counts.review_required_reassigned).toBe(1);
    expect(result.rows.every((row) => row.status !== "completed")).toBe(true);
    expect(result.rows.every((row) => row.status !== "discarded")).toBe(true);
  });

  it("returns rows in created_at DESC order", async () => {
    const oldest = new Date("2026-01-01T00:00:00Z");
    const middle = new Date("2026-03-01T00:00:00Z");
    const newest = new Date("2026-05-01T00:00:00Z");
    const idOldest = await insertRow({
      specialistId: "S-1",
      status: "pending_sync",
      createdAt: oldest,
    });
    const idNewest = await insertRow({
      specialistId: "S-1",
      status: "pending_sync",
      createdAt: newest,
    });
    const idMiddle = await insertRow({
      specialistId: "S-1",
      status: "pending_sync",
      createdAt: middle,
    });

    const result = await repo.getPendingForSpecialist(db, "S-1");
    expect(result.rows.map((row) => row.id)).toEqual([
      idNewest,
      idMiddle,
      idOldest,
    ]);
  });

  it("returns per-status counts across all non-terminal statuses", async () => {
    await insertRow({ specialistId: "S-1", status: "pending_sync" });
    await insertRow({ specialistId: "S-1", status: "pending_sync" });
    await insertRow({ specialistId: "S-1", status: "in_flight" });
    await insertRow({ specialistId: "S-1", status: "review_required_reassigned" });
    await insertRow({ specialistId: "S-1", status: "review_required_terminated" });
    await insertRow({ specialistId: "S-1", status: "failed_max_retries" });
    // Terminal — excluded.
    await insertRow({ specialistId: "S-1", status: "completed" });

    const result = await repo.getPendingForSpecialist(db, "S-1");
    expect(result.counts).toEqual({
      pending_sync: 2,
      in_flight: 1,
      review_required_reassigned: 1,
      review_required_terminated: 1,
      failed_max_retries: 1,
    });
    expect(result.queueDepth).toBe(6);
  });

  it("returns zero counts and empty rows for a specialist with no pending items", async () => {
    const result = await repo.getPendingForSpecialist(db, "S-empty");
    expect(result.rows).toEqual([]);
    expect(result.queueDepth).toBe(0);
    expect(result.counts).toEqual({
      pending_sync: 0,
      in_flight: 0,
      review_required_reassigned: 0,
      review_required_terminated: 0,
      failed_max_retries: 0,
    });
  });

  it("caps rows at QUEUE_PENDING_MAX_ITEMS but reports the true queueDepth", async () => {
    // Seed 102 rows — beyond the 100 cap. INTENTIONALLY sequential (not
    // batched / parallelized): each row needs a strictly increasing
    // created_at to give the DESC-order assertion a deterministic ordering.
    // A parallel insert with NOW() defaults would collide on the timestamp.
    const base = Date.parse("2026-05-01T00:00:00Z");
    for (let i = 0; i < 102; i += 1) {
      await insertRow({
        specialistId: "S-bulk",
        status: "pending_sync",
        createdAt: new Date(base + i * 1000),
      });
    }
    const result = await repo.getPendingForSpecialist(db, "S-bulk");
    expect(result.rows).toHaveLength(100);
    expect(result.queueDepth).toBe(102);
    expect(result.counts.pending_sync).toBe(102);
  });
});
