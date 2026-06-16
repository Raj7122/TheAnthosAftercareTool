import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_WORKER_ID,
  runPollCycle,
  type CdcWorkerPersistence,
} from "../../src/workers/sf-cdc-poll.js";

// Unit-shape coverage for `runPollCycle` — exercises the worker's pure cycle
// behavior against an in-memory `CdcWorkerPersistence` fake, with no Postgres
// involved. The DB round-trip is covered by the sibling integration suite.
// Focus here: the OwnerId-fan-out contract — many CDC events for one
// specialist (across one or more SObjects) collapse to ONE invalidate call.

type Modstamp = string;
interface FakeRecord {
  Id: string;
  OwnerId: string | null;
  SystemModstamp: Modstamp;
}

// Per-object SOQL responses. The fake SF client returns the queue for the
// object in the FROM clause; SOQL formation is validated by the cdc-poll
// unit suite, so we just key on the object name. Keyed via Map (not a plain
// object) to keep the lookup off security/detect-object-injection.
function makeSfClient(responses: ReadonlyMap<string, FakeRecord[]>) {
  const calls: string[] = [];
  const fakeRest = {
    async query(soql: string) {
      calls.push(soql);
      const fromMatch = /FROM (\w+)/.exec(soql);
      const object = fromMatch?.[1] ?? "";
      const records = responses.get(object) ?? [];
      return { totalSize: records.length, done: true, records };
    },
  };
  return { calls, sfClient: fakeRest as unknown as Parameters<typeof runPollCycle>[0]["sfClient"] };
}

function responsesMap(
  entries: Record<string, FakeRecord[]>,
): ReadonlyMap<string, FakeRecord[]> {
  return new Map(Object.entries(entries));
}

function makePersistence(): {
  fake: CdcWorkerPersistence;
  invalidateCalls: Array<{ specialistId: string }>;
  recordCycleInputs: Array<unknown>;
  initialCursors: Record<string, string>;
} {
  const invalidateCalls: Array<{ specialistId: string }> = [];
  const recordCycleInputs: Array<unknown> = [];
  const initialCursors: Record<string, string> = {};
  const fake: CdcWorkerPersistence = {
    async readCursors() {
      return { ...initialCursors };
    },
    async invalidateCaseloadCache(_db, scope) {
      if (scope.kind === "specialist") {
        invalidateCalls.push({ specialistId: scope.specialistId });
        return 1;
      }
      return 0;
    },
    async recordCycle(_db, input) {
      recordCycleInputs.push(input);
    },
  };
  return { fake, invalidateCalls, recordCycleInputs, initialCursors };
}

const NULL_LOGGER = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child() {
    return NULL_LOGGER;
  },
};

// `db` is opaque to the worker when `persistence` is injected — the fake's
// methods ignore it. A nullish `as` cast keeps the test free of a real DB.
const FAKE_DB = null as unknown as Parameters<typeof runPollCycle>[0]["db"];

describe("runPollCycle — OwnerId fan-out contract", () => {
  it("collapses two events from one OwnerId across two objects into ONE invalidate call", async () => {
    const ownerA = "005AAAAAAAAAAAAA";
    const { sfClient } = makeSfClient(
      responsesMap({
        // Same OwnerId on both objects.
        IDW_Case_Note__c: [
          { Id: "a01", OwnerId: ownerA, SystemModstamp: "2026-05-22T12:01:00.000Z" },
        ],
        Barriers__c: [
          { Id: "a02", OwnerId: ownerA, SystemModstamp: "2026-05-22T12:02:00.000Z" },
        ],
      }),
    );
    const { fake, invalidateCalls } = makePersistence();
    const result = await runPollCycle({
      db: FAKE_DB,
      sfClient,
      logger: NULL_LOGGER,
      persistence: fake,
      workerId: DEFAULT_WORKER_ID,
    });
    expect(result.eventsTotal).toBe(2);
    expect(result.invalidations).toBe(1);
    expect(invalidateCalls).toHaveLength(1);
    expect(invalidateCalls[0]?.specialistId).toBe(ownerA);
  });

  it("dispatches one invalidate per distinct OwnerId across multiple objects", async () => {
    const ownerA = "005AAAAAAAAAAAAA";
    const ownerB = "005BBBBBBBBBBBBB";
    const { sfClient } = makeSfClient(
      responsesMap({
        IDW_Case_Note__c: [
          { Id: "a01", OwnerId: ownerA, SystemModstamp: "2026-05-22T12:01:00.000Z" },
          { Id: "a02", OwnerId: ownerB, SystemModstamp: "2026-05-22T12:02:00.000Z" },
          // Repeat OwnerA — still one call per specialist.
          { Id: "a03", OwnerId: ownerA, SystemModstamp: "2026-05-22T12:03:00.000Z" },
        ],
        Barriers__c: [
          { Id: "b01", OwnerId: ownerB, SystemModstamp: "2026-05-22T12:04:00.000Z" },
        ],
      }),
    );
    const { fake, invalidateCalls } = makePersistence();
    const result = await runPollCycle({
      db: FAKE_DB,
      sfClient,
      logger: NULL_LOGGER,
      persistence: fake,
    });
    expect(result.eventsTotal).toBe(4);
    expect(result.invalidations).toBe(2);
    const specialistIds = invalidateCalls.map((c) => c.specialistId).sort();
    expect(specialistIds).toEqual([ownerA, ownerB]);
  });

  it("skips invalidations entirely on a zero-event cycle", async () => {
    const { sfClient } = makeSfClient(responsesMap({}));
    const { fake, invalidateCalls, recordCycleInputs } = makePersistence();
    const result = await runPollCycle({
      db: FAKE_DB,
      sfClient,
      logger: NULL_LOGGER,
      persistence: fake,
    });
    expect(result.eventsTotal).toBe(0);
    expect(result.invalidations).toBe(0);
    expect(invalidateCalls).toHaveLength(0);
    // Cycle still recorded — the heartbeat advance happens even on empty cycles.
    expect(recordCycleInputs).toHaveLength(1);
  });

  it("ignores records with a null or empty OwnerId", async () => {
    const ownerA = "005AAAAAAAAAAAAA";
    const { sfClient } = makeSfClient(
      responsesMap({
        IDW_Case_Note__c: [
          { Id: "a01", OwnerId: null, SystemModstamp: "2026-05-22T12:01:00.000Z" },
          { Id: "a02", OwnerId: "", SystemModstamp: "2026-05-22T12:02:00.000Z" },
          { Id: "a03", OwnerId: ownerA, SystemModstamp: "2026-05-22T12:03:00.000Z" },
        ],
      }),
    );
    const { fake, invalidateCalls } = makePersistence();
    const result = await runPollCycle({
      db: FAKE_DB,
      sfClient,
      logger: NULL_LOGGER,
      persistence: fake,
    });
    expect(result.eventsTotal).toBe(3);
    expect(invalidateCalls).toHaveLength(1);
    expect(invalidateCalls[0]?.specialistId).toBe(ownerA);
  });

  it("advances cursors AFTER invalidations dispatch (event-loss ordering)", async () => {
    const ownerA = "005AAAAAAAAAAAAA";
    const callOrder: string[] = [];
    const { sfClient } = makeSfClient(
      responsesMap({
        IDW_Case_Note__c: [
          { Id: "a01", OwnerId: ownerA, SystemModstamp: "2026-05-22T12:01:00.000Z" },
        ],
      }),
    );
    const fake: CdcWorkerPersistence = {
      async readCursors() {
        return {};
      },
      async invalidateCaseloadCache() {
        callOrder.push("invalidate");
        return 1;
      },
      async recordCycle() {
        callOrder.push("recordCycle");
      },
    };
    await runPollCycle({
      db: FAKE_DB,
      sfClient,
      logger: NULL_LOGGER,
      persistence: fake,
    });
    // Every `invalidate` MUST precede every `recordCycle` so a crash between
    // them re-polls the same window on the next cycle (no event loss).
    const firstRecord = callOrder.indexOf("recordCycle");
    const lastInvalidate = callOrder.lastIndexOf("invalidate");
    expect(lastInvalidate).toBeLessThan(firstRecord);
  });

  it("emits exactly one info log line per cycle (the structured cycle record)", async () => {
    const ownerA = "005AAAAAAAAAAAAA";
    const { sfClient } = makeSfClient(
      responsesMap({
        IDW_Case_Note__c: [
          { Id: "a01", OwnerId: ownerA, SystemModstamp: "2026-05-22T12:01:00.000Z" },
        ],
      }),
    );
    const { fake } = makePersistence();
    const infoLines: Array<{ message: string; fields: Record<string, unknown> }> = [];
    const logger = {
      debug: vi.fn(),
      info: (message: string, fields: Record<string, unknown> = {}) =>
        infoLines.push({ message, fields }),
      warn: vi.fn(),
      error: vi.fn(),
      child: function () {
        return this;
      },
    };
    await runPollCycle({
      db: FAKE_DB,
      sfClient,
      logger,
      persistence: fake,
    });
    const cycleLines = infoLines.filter(
      (l) => l.fields["event"] === "sf_cdc_poll.cycle",
    );
    expect(cycleLines).toHaveLength(1);
    // PII firewall: none of the canonical participant-keyed fields appear.
    const keys = Object.keys(cycleLines[0]?.fields ?? {});
    expect(keys).not.toContain("participant_id");
    expect(keys).not.toContain("email");
    expect(keys).not.toContain("phone");
  });
});
