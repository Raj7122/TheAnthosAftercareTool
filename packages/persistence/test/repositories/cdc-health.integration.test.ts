import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// Hits a real Postgres (Supabase/Neon) via DEMO_POSTGRES_URL. Round-trip proof
// for the P1C-03 cdc_health repository: cursor read/write, status transitions,
// recovery-mode evaluation, and the staleness contract P1C-04 will consume.
// Skipped when DEMO_POSTGRES_URL is unset so CI stays green. Exercises
// migration 0008 (the table must exist).

const RUN = !!process.env.DEMO_POSTGRES_URL;

const WORKER_ID = "test-sf-cdc-poll";

describe.skipIf(!RUN)("cdc-health repository (integration)", () => {
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
    await db.execute(sql`TRUNCATE TABLE cdc_health`);
  });

  it("readCursors returns empty for a never-recorded worker", async () => {
    const cursors = await repo.readCursors(db, WORKER_ID);
    expect(cursors).toEqual({});
  });

  it("readStaleness reports DISCONNECTED before any heartbeat", async () => {
    const s = await repo.readStaleness(db, WORKER_ID);
    expect(s.status).toBe("DISCONNECTED");
    expect(s.lastHeartbeatAt).toBeNull();
    expect(s.lastEventReceivedAt).toBeNull();
  });

  it("recordCycle inserts a fresh row on first run", async () => {
    await repo.recordCycle(db, {
      workerId: WORKER_ID,
      cursors: { Case_Note__c: "2026-05-22T12:00:00.000Z" },
      lastEventId: "Case_Note__c:a0Xabc",
      lastEventReceivedAt: new Date("2026-05-22T12:00:00.000Z"),
      subscriptionStatus: "CONNECTED",
      cycleErrored: false,
    });
    const cursors = await repo.readCursors(db, WORKER_ID);
    expect(cursors["Case_Note__c"]).toBe("2026-05-22T12:00:00.000Z");
    const s = await repo.readStaleness(db, WORKER_ID);
    expect(s.status).toBe("CONNECTED");
    expect(s.lastEventReceivedAt).toBeInstanceOf(Date);
  });

  it("recordCycle merges cursors across cycles", async () => {
    await repo.recordCycle(db, {
      workerId: WORKER_ID,
      cursors: { Case_Note__c: "2026-05-22T12:00:00.000Z" },
      lastEventId: null,
      lastEventReceivedAt: null,
      subscriptionStatus: "CONNECTED",
      cycleErrored: false,
    });
    await repo.recordCycle(db, {
      workerId: WORKER_ID,
      cursors: {
        Case_Note__c: "2026-05-22T12:00:30.000Z",
        Barriers__c: "2026-05-22T12:00:30.000Z",
      },
      lastEventId: null,
      lastEventReceivedAt: null,
      subscriptionStatus: "CONNECTED",
      cycleErrored: false,
    });
    const cursors = await repo.readCursors(db, WORKER_ID);
    expect(cursors).toEqual({
      Case_Note__c: "2026-05-22T12:00:30.000Z",
      Barriers__c: "2026-05-22T12:00:30.000Z",
    });
  });

  it("recordCycle preserves last_event_* when the cycle was empty", async () => {
    await repo.recordCycle(db, {
      workerId: WORKER_ID,
      cursors: {},
      lastEventId: "Case_Note__c:abc",
      lastEventReceivedAt: new Date("2026-05-22T12:00:00.000Z"),
      subscriptionStatus: "CONNECTED",
      cycleErrored: false,
    });
    // Zero-event follow-up cycle.
    await repo.recordCycle(db, {
      workerId: WORKER_ID,
      cursors: {},
      lastEventId: null,
      lastEventReceivedAt: null,
      subscriptionStatus: "CONNECTED",
      cycleErrored: false,
    });
    const s = await repo.readStaleness(db, WORKER_ID);
    expect(s.lastEventReceivedAt?.toISOString()).toBe(
      "2026-05-22T12:00:00.000Z",
    );
  });

  it("evaluateRecoveryMode returns first_run when no heartbeat", async () => {
    const mode = await repo.evaluateRecoveryMode(db, WORKER_ID);
    expect(mode).toBe("first_run_full_hydrate");
  });

  it("evaluateRecoveryMode returns safe_to_replay for a recent event", async () => {
    await repo.recordCycle(db, {
      workerId: WORKER_ID,
      cursors: {},
      lastEventId: "Case_Note__c:abc",
      lastEventReceivedAt: new Date(),
      subscriptionStatus: "CONNECTED",
      cycleErrored: false,
    });
    const mode = await repo.evaluateRecoveryMode(db, WORKER_ID);
    expect(mode).toBe("safe_to_replay");
  });

  it("evaluateRecoveryMode returns replay_window_expired past 72h", async () => {
    await repo.recordCycle(db, {
      workerId: WORKER_ID,
      cursors: {},
      lastEventId: "Case_Note__c:abc",
      lastEventReceivedAt: new Date("2020-01-01T00:00:00.000Z"),
      subscriptionStatus: "CONNECTED",
      cycleErrored: false,
    });
    const mode = await repo.evaluateRecoveryMode(db, WORKER_ID);
    expect(mode).toBe("replay_window_expired_full_hydrate");
  });
});
