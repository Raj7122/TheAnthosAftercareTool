import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  runPollCycle,
  runPollInvocation,
} from "../../src/workers/sf-cdc-poll.js";

// End-to-end proof of the P1C-03 worker contract: a polled CDC event advances
// the cdc_health cursor + heartbeat and emits exactly one structured log line
// per cycle. Hits a real Postgres via DEMO_POSTGRES_URL; skipped when unset.
//
// Scope note — this suite does NOT assert caseload_cache eviction or the
// invalidate-count. P1C-02's `caseload-cache.integration.test.ts` `TRUNCATE`s
// `caseload_cache` in `beforeEach`; run in parallel against the shared demo
// DB it would wipe the cache row between this test's seed and the worker's
// invalidate call. Same posture as `get-caseload.integration.test.ts`. The
// invalidate dispatch itself is covered by P1C-02's repository integration
// suite (`caseload-cache.integration.test.ts`) and by the unit-shape
// assertion on `runPollCycle`'s deduped OwnerId fan-out.

const RUN = !!process.env.DEMO_POSTGRES_URL;

const SF_CASE_NOTE_ID = "a0X0000000ABCDE";
const CURSOR_ISO = "2026-05-22T12:00:00.000Z";
const NEXT_CURSOR_ISO = "2026-05-22T12:01:00.000Z";

// Stable-looking but unique-per-suite-run worker id keeps each test row
// isolated without needing a TRUNCATE — `@anthos/api` does not depend on
// drizzle-orm directly, so `sql\`TRUNCATE ...\`` is not reachable from here.
function makeWorkerId(): string {
  return `test-sf-cdc-poll-${randomUUID().slice(0, 8)}`;
}

// Stable-looking but unique-per-test owner Salesforce User Id, 18-char alpha
// numeric. Keeps the caseload_cache rows we seed disjoint from any other
// run sharing the database.
function makeOwnerId(): string {
  return `005${randomUUID().replace(/-/g, "").slice(0, 15)}`;
}

interface LoggedLine {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  fields: Record<string, unknown>;
}

// Mirrors the real logger's canonical-field projection: `traceId` on the
// `LogContext` becomes `trace_id` on the wire record (`packages/logging`
// `buildRecord`). Keeps the assertion below faithful to what the real logger
// emits.
function recordingLogger() {
  const lines: LoggedLine[] = [];
  const make = (extra: { traceId?: string; specialistId?: string }) => ({
    debug: (message: string, fields: Record<string, unknown> = {}) =>
      lines.push({ level: "debug", message, fields: { ...project(extra), ...fields } }),
    info: (message: string, fields: Record<string, unknown> = {}) =>
      lines.push({ level: "info", message, fields: { ...project(extra), ...fields } }),
    warn: (message: string, fields: Record<string, unknown> = {}) =>
      lines.push({ level: "warn", message, fields: { ...project(extra), ...fields } }),
    error: (message: string, fields: Record<string, unknown> = {}) =>
      lines.push({ level: "error", message, fields: { ...project(extra), ...fields } }),
    child: (childExtra: { traceId?: string; specialistId?: string }) =>
      make({ ...extra, ...childExtra }),
  });
  return { lines, logger: make({}) };
}

function project(ctx: {
  traceId?: string;
  specialistId?: string;
}): Record<string, string> {
  const out: Record<string, string> = {};
  if (ctx.traceId !== undefined) out["trace_id"] = ctx.traceId;
  if (ctx.specialistId !== undefined) out["specialist_id"] = ctx.specialistId;
  return out;
}

// Minimal SF client stub. Returns a single CDC event the first time
// `Case_Note__c` is polled, empty results for the other canonical objects.
function makeSfClient(ownerId: string): {
  client: { query: (soql: string) => Promise<{ totalSize: number; done: boolean; records: unknown[] }> };
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    client: {
      async query(soql: string) {
        calls.push(soql);
        if (soql.startsWith("SELECT Id, OwnerId, SystemModstamp FROM IDW_Case_Note__c")) {
          return {
            totalSize: 1,
            done: true,
            records: [
              {
                Id: SF_CASE_NOTE_ID,
                OwnerId: ownerId,
                SystemModstamp: NEXT_CURSOR_ISO,
              },
            ],
          };
        }
        return { totalSize: 0, done: true, records: [] };
      },
    },
  };
}

describe.skipIf(!RUN)("sf-cdc-poll worker (integration)", () => {
  let db: (typeof import("@anthos/persistence"))["db"];
  let closeDb: (typeof import("@anthos/persistence"))["closeDb"];
  let repo: typeof import("@anthos/persistence")["repositories"];

  beforeAll(async () => {
    const persistence = await import("@anthos/persistence");
    db = persistence.db;
    closeDb = persistence.closeDb;
    repo = persistence.repositories;
  });

  afterAll(async () => {
    await closeDb();
  });

  it("polls → advances the cursor → records the cycle", async () => {
    const workerId = makeWorkerId();
    const ownerId = makeOwnerId();
    await repo.recordCycle(db, {
      workerId,
      cursors: {
        IDW_Case_Note__c: CURSOR_ISO,
        Barriers__c: CURSOR_ISO,
        Incident__c: CURSOR_ISO,
        IDW_Program_Enrollment__c: CURSOR_ISO,
      },
      lastEventId: null,
      lastEventReceivedAt: null,
      subscriptionStatus: "CONNECTED",
      cycleErrored: false,
    });

    const { lines, logger } = recordingLogger();
    const { client: sfClient } = makeSfClient(ownerId);

    const result = await runPollCycle({
      db,
      sfClient: sfClient as unknown as Parameters<typeof runPollCycle>[0]["sfClient"],
      logger,
      workerId,
    });

    expect(result.eventsTotal).toBe(1);
    expect(result.status).toBe("CONNECTED");

    const cursors = await repo.readCursors(db, workerId);
    expect(cursors["IDW_Case_Note__c"]).toBe(NEXT_CURSOR_ISO);

    const s = await repo.readStaleness(db, workerId);
    expect(s.status).toBe("CONNECTED");
    expect(s.lastHeartbeatAt).toBeInstanceOf(Date);
    expect(s.lastEventReceivedAt?.toISOString()).toBe(NEXT_CURSOR_ISO);

    const cycleLines = lines.filter(
      (l) => l.fields["event"] === "sf_cdc_poll.cycle",
    );
    expect(cycleLines).toHaveLength(1);
    expect(cycleLines[0]?.fields["trace_id"]).toEqual(result.traceId);
    const keys = Object.keys(cycleLines[0]?.fields ?? {});
    expect(keys).not.toContain("participant_id");
    expect(keys).not.toContain("message");
    expect(keys).not.toContain("email");
    expect(keys).not.toContain("phone");
  });

  it("runPollInvocation runs two cycles 30s apart (stubbed sleep)", async () => {
    const workerId = makeWorkerId();
    const ownerId = makeOwnerId();
    await repo.recordCycle(db, {
      workerId,
      cursors: {
        IDW_Case_Note__c: CURSOR_ISO,
        Barriers__c: CURSOR_ISO,
        Incident__c: CURSOR_ISO,
        IDW_Program_Enrollment__c: CURSOR_ISO,
      },
      lastEventId: "Case_Note__c:bootstrap",
      lastEventReceivedAt: new Date(),
      subscriptionStatus: "CONNECTED",
      cycleErrored: false,
    });

    const { logger } = recordingLogger();
    const { client: sfClient } = makeSfClient(ownerId);

    const sleep = vi.fn(async () => {});
    // runPollInvocation uses the default worker id, so it isn't observed
    // through the per-test worker id above. We assert on the cycle count + the
    // 30s sleep — the cycle behavior itself is exercised by `runPollCycle`.
    const result = await runPollInvocation({
      db,
      sfClient: sfClient as unknown as Parameters<
        typeof runPollInvocation
      >[0] extends infer O
        ? O extends { sfClient?: infer S }
          ? S
          : never
        : never,
      logger,
      sleep,
    });

    expect(result.cycles).toHaveLength(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(30_000);
  });

  it("flips status to RECONNECTING on a cycle error", async () => {
    const workerId = makeWorkerId();
    const { logger } = recordingLogger();
    const failingClient = {
      async query() {
        throw new Error("SF_NETWORK_TIMEOUT");
      },
    };

    const result = await runPollCycle({
      db,
      sfClient: failingClient as unknown as Parameters<
        typeof runPollCycle
      >[0]["sfClient"],
      logger,
      workerId,
    });

    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.status).toBe("RECONNECTING");

    const s = await repo.readStaleness(db, workerId);
    expect(s.status).toBe("RECONNECTING");
  });

  it("trace_id is unique per cycle", async () => {
    const workerId = makeWorkerId();
    const ownerId = makeOwnerId();
    const { logger } = recordingLogger();
    const { client: sfClient } = makeSfClient(ownerId);
    const c1 = await runPollCycle({
      db,
      sfClient: sfClient as unknown as Parameters<typeof runPollCycle>[0]["sfClient"],
      logger,
      workerId,
    });
    const c2 = await runPollCycle({
      db,
      sfClient: sfClient as unknown as Parameters<typeof runPollCycle>[0]["sfClient"],
      logger,
      workerId,
    });
    expect(c1.traceId).not.toEqual(c2.traceId);
    expect(c1.traceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$|^[0-9a-f]{24}$/,
    );
  });
});
