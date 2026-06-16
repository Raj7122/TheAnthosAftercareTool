import { describe, expect, it, vi } from "vitest";

import { buildCaseloadBody, type CaseloadBody, type CaseloadItem } from "../../src/caseload/dto.js";
import { hydrateDisplayNames } from "../../src/caseload/hydrate-display-names.js";

const NOW_MS = new Date("2026-05-25T12:00:00Z").getTime();

function makeItem(participantId: string, displayName: string | null): CaseloadItem {
  return {
    participantId,
    displayName,
    peLabel: null,
    programCode: null,
    aftercareDay: null,
    aftercareStartDate: null,
    tier: null,
    tierLabel: null,
    priorityScore: null,
    priorityModifier: null,
    highestImpactFactor: null,
    factors: [],
    secondaryFactorLabel: null,
    triggered_invariants: [],
    lastSuccessfulContactDaysAgo: null,
    stabilityVisit: {
      status: "on_track",
      statusLabel: "On track",
      nextDueDate: null,
      checkpoint: null,
      completedCount: null,
      missedCount: null,
      scheduledVisitDateTime: null,
    },
    cycleStatus: {
      state: "on_track",
      daysToNext: null,
      daysOverdue: 0,
      nextCheckpoint: null,
      lastCreditedCheckpoint: null,
    },
    perCheckpointBreakdown: [],
    openBarriers: [],
    tags: [],
    pathCSuppression: null,
    voucherRecertDays: null,
    dataIssues: [],
  };
}

function makeBody(items: ReadonlyArray<CaseloadItem>): CaseloadBody {
  return buildCaseloadBody({
    specialistId: "0058K00000XYZAbQAO",
    queueId: "caseload_overview",
    queueCounts: { caseload_overview: items.length },
    cacheAgeSeconds: 0,
    configurationVersion: 1,
    items,
  });
}

describe("hydrateDisplayNames", () => {
  it("is a no-op when every item already has a displayName (cold-path responses)", async () => {
    const body = makeBody([makeItem("p-1", "Alice"), makeItem("p-2", "Bob")]);
    const runQuery = vi.fn();
    const out = await hydrateDisplayNames(body, { runQuery, cache: new Map() });
    expect(runQuery).not.toHaveBeenCalled();
    expect(out.items.map((i) => i.displayName)).toEqual(["Alice", "Bob"]);
  });

  it("resolves names from the in-memory cache without hitting Salesforce", async () => {
    const cache = new Map([
      ["p-1", { name: "Alice", expiresAt: NOW_MS + 60_000 }],
      ["p-2", { name: "Bob", expiresAt: NOW_MS + 60_000 }],
    ]);
    const body = makeBody([makeItem("p-1", null), makeItem("p-2", null)]);
    const runQuery = vi.fn();
    const out = await hydrateDisplayNames(body, {
      cache,
      runQuery,
      now: () => NOW_MS,
    });
    expect(runQuery).not.toHaveBeenCalled();
    expect(out.items.map((i) => i.displayName)).toEqual(["Alice", "Bob"]);
  });

  it("issues exactly one bulk SOQL backfill for cache misses and caches the result", async () => {
    const cache = new Map();
    const body = makeBody([makeItem("p-1", null), makeItem("p-2", null)]);
    const runQuery = vi.fn(async (ids: ReadonlyArray<string>) =>
      ids.map((id) => ({ Id: id, Contact__r: { Name: `Name-${id}` } })),
    );
    const out = await hydrateDisplayNames(body, {
      cache,
      runQuery,
      now: () => NOW_MS,
    });
    expect(runQuery).toHaveBeenCalledTimes(1);
    expect(runQuery.mock.calls[0]?.[0]).toEqual(["p-1", "p-2"]);
    expect(out.items.map((i) => i.displayName)).toEqual(["Name-p-1", "Name-p-2"]);
    // A second call within the TTL window should see no SF traffic.
    runQuery.mockClear();
    await hydrateDisplayNames(body, { cache, runQuery, now: () => NOW_MS + 1_000 });
    expect(runQuery).not.toHaveBeenCalled();
  });

  it("re-queries Salesforce after the TTL window expires", async () => {
    const cache = new Map();
    const body = makeBody([makeItem("p-1", null)]);
    const runQuery = vi.fn(async (ids: ReadonlyArray<string>) =>
      ids.map((id) => ({ Id: id, Contact__r: { Name: `Name-${id}` } })),
    );
    await hydrateDisplayNames(body, {
      cache,
      runQuery,
      now: () => NOW_MS,
      ttlMs: 1_000,
    });
    expect(runQuery).toHaveBeenCalledTimes(1);
    await hydrateDisplayNames(body, {
      cache,
      runQuery,
      now: () => NOW_MS + 2_000,
      ttlMs: 1_000,
    });
    expect(runQuery).toHaveBeenCalledTimes(2);
  });

  it("caches a not-found row as null so it does not re-query each request", async () => {
    const cache = new Map();
    const body = makeBody([makeItem("p-missing", null)]);
    const runQuery = vi.fn(async () => []);
    const out = await hydrateDisplayNames(body, { cache, runQuery, now: () => NOW_MS });
    expect(out.items[0]?.displayName).toBeNull();
    runQuery.mockClear();
    await hydrateDisplayNames(body, { cache, runQuery, now: () => NOW_MS });
    expect(runQuery).not.toHaveBeenCalled();
  });

  it("batches misses into multiple SF queries when the count exceeds batchSize", async () => {
    const cache = new Map();
    const items = Array.from({ length: 5 }, (_, n) => makeItem(`p-${n}`, null));
    const body = makeBody(items);
    const runQuery = vi.fn(async (ids: ReadonlyArray<string>) =>
      ids.map((id) => ({ Id: id, Contact__r: { Name: `Name-${id}` } })),
    );
    await hydrateDisplayNames(body, {
      cache,
      runQuery,
      now: () => NOW_MS,
      batchSize: 2,
    });
    expect(runQuery).toHaveBeenCalledTimes(3);
    expect(runQuery.mock.calls[0]?.[0]).toHaveLength(2);
    expect(runQuery.mock.calls[1]?.[0]).toHaveLength(2);
    expect(runQuery.mock.calls[2]?.[0]).toHaveLength(1);
  });

  it("does not mutate the input body", async () => {
    const cache = new Map([["p-1", { name: "Alice", expiresAt: NOW_MS + 60_000 }]]);
    const body = makeBody([makeItem("p-1", null)]);
    const out = await hydrateDisplayNames(body, { cache, now: () => NOW_MS });
    expect(body.items[0]?.displayName).toBeNull();
    expect(out.items[0]?.displayName).toBe("Alice");
    expect(out).not.toBe(body);
  });
});
