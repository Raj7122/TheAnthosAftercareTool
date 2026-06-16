import { hashToken, loadSessionConfig, mintToken } from "@anthos/auth";
import type { Role } from "@anthos/auth";
import { getCalibrationConfiguration } from "@anthos/domain";
import { SalesforceError } from "@anthos/integrations";
import type { DbOrTx } from "@anthos/persistence";
import { describe, expect, it, vi } from "vitest";

import { buildCaseloadBody, type CaseloadBody } from "../../src/caseload/dto.js";
import { handleCaseload } from "../../src/caseload/get-caseload.js";
import type { CaseloadHandlerOptions } from "../../src/caseload/get-caseload.js";
import type {
  ScoreCaseloadResult,
  ScoredParticipant,
} from "../../src/caseload/score-caseload.js";
import type { SessionRecord, SessionStore } from "../../src/session/store.js";
import { dueDatesWith, makeEngineOutput, makeScored, makeSnapshot } from "./_fixtures.js";

// ── fixtures ────────────────────────────────────────────────────────────────

const SESSION_CONFIG = loadSessionConfig({});
const HOUR = 60 * 60 * 1000;
const SPECIALIST_ID = "0058K00000XYZAbQAO";
const NOW = new Date("2026-05-15T12:00:00Z");
const CONFIG = getCalibrationConfiguration();
// A non-DB sentinel — every DB-touching seam is faked, so `db` is never read.
const FAKE_DB = {} as unknown as DbOrTx;

// In-memory SessionStore — `withSession` resolves seeded rows by token hash.
function makeStore(): { store: SessionStore; seed: (role?: Role) => string } {
  const rows = new Map<string, SessionRecord>();
  let n = 0;
  const store: SessionStore = {
    create: () => Promise.reject(new Error("create unused")),
    getByTokenHash: (h) => Promise.resolve(rows.get(h) ?? null),
    getSalesforceRefreshToken: () => Promise.resolve(null),
    touch: () => Promise.resolve(),
    applySessionRefresh: () => Promise.resolve(),
    revoke: () => Promise.resolve(),
    cleanupExpired: () => Promise.resolve(0),
  };
  function seed(role: Role = "SPECIALIST"): string {
    n += 1;
    const token = mintToken();
    rows.set(hashToken(token), {
      id: `session-${n}`,
      specialistId: SPECIALIST_ID,
      role,
      lastActivityAt: new Date(),
      expiresAt: new Date(Date.now() + 11 * HOUR),
      revoked: false,
      displayName: "Marie Alcis",
      email: "malcis@anthoshome.org",
      timezone: "America/New_York",
    });
    return token;
  }
  return { store, seed };
}

function caseloadReq(token?: string, queue?: string): Request {
  const headers = new Headers();
  if (token !== undefined) headers.set("Cookie", `anthos_session=${token}`);
  const url = new URL("https://bff.test/api/v1/caseload");
  if (queue !== undefined) url.searchParams.set("queue", queue);
  return new Request(url, { method: "GET", headers });
}

function makeResult(
  scored: ReadonlyArray<ScoredParticipant>,
  roundTrips = 2,
): ScoreCaseloadResult {
  return { scored, roundTrips, hydratedAt: NOW, configuration: CONFIG, now: NOW };
}

// A cache reader that always reports the given freshness.
function cacheReaderReturning(
  freshness: "fresh" | "stale" | "miss",
  payload: CaseloadBody | null,
  lastRefreshedAt: Date | null,
): NonNullable<CaseloadHandlerOptions["cacheReader"]> {
  return () => Promise.resolve({ freshness, payload, lastRefreshedAt });
}

// Base handler options — every DB / SF / audit seam faked, so no test touches
// a real connection. `cacheReader` / `scoreCaseloadImpl` are per-test.
function baseOptions(
  store: SessionStore,
  overrides: Partial<CaseloadHandlerOptions> = {},
): CaseloadHandlerOptions {
  return {
    store,
    sessionConfig: SESSION_CONFIG,
    configuration: CONFIG,
    db: FAKE_DB,
    cacheWriter: vi.fn(() => Promise.resolve()),
    writeAudit: vi.fn(() => Promise.resolve({ id: "audit-1" })),
    now: () => NOW,
    ...overrides,
  };
}

// ── auth gate ───────────────────────────────────────────────────────────────

describe("handleCaseload — auth gate", () => {
  it("401 AUTH_SESSION_INVALID when no session cookie is present", async () => {
    const { store } = makeStore();
    const res = await handleCaseload(
      caseloadReq(),
      baseOptions(store, {
        cacheReader: cacheReaderReturning("miss", null, null),
      }),
    );
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe(
      "AUTH_SESSION_INVALID",
    );
  });
});

// ── warm path ───────────────────────────────────────────────────────────────

describe("handleCaseload — warm path", () => {
  it("returns the cached body with a recomputed cacheAgeSeconds, no SF call, no audit", async () => {
    const { store, seed } = makeStore();
    const token = seed();
    const cachedBody = buildCaseloadBody({
      specialistId: SPECIALIST_ID,
      queueId: "caseload_overview",
      queueCounts: { "caseload_overview": 7 },
      cacheAgeSeconds: 0,
      configurationVersion: 0,
      items: [],
    });
    const scoreSpy = vi.fn();
    const writeAudit = vi.fn(() => Promise.resolve({ id: "a" }));

    const res = await handleCaseload(
      caseloadReq(token, "caseload_overview"),
      baseOptions(store, {
        cacheReader: cacheReaderReturning(
          "fresh",
          cachedBody,
          new Date(NOW.getTime() - 120_000),
        ),
        scoreCaseloadImpl: scoreSpy as never,
        writeAudit,
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as CaseloadBody;
    expect(body.queue).toBe("caseload_overview");
    expect(body.cacheAgeSeconds).toBe(120);
    expect(body.queueCounts).toEqual({ "caseload_overview": 7 });
    // Warm read: never hydrates, never audits.
    expect(scoreSpy).not.toHaveBeenCalled();
    expect(writeAudit).not.toHaveBeenCalled();
  });

  // P1H-13a — warm-cache rows have `displayName: null` (stripped per Immutable
  // #1); the hydrate step re-attaches names before the response.
  it("re-attaches displayName on warm reads via the hydrate seam", async () => {
    const { store, seed } = makeStore();
    const token = seed();
    const cachedBody = buildCaseloadBody({
      specialistId: SPECIALIST_ID,
      queueId: "caseload_overview",
      queueCounts: { caseload_overview: 1 },
      cacheAgeSeconds: 0,
      configurationVersion: 0,
      items: [
        {
          ...buildCaseloadItem(),
          participantId: "p-1",
          displayName: null,
        },
      ],
    });
    const hydrateSpy = vi.fn(async (body: CaseloadBody) => ({
      ...body,
      items: body.items.map((item) => ({ ...item, displayName: "Hydrated Name" })),
    }));

    const res = await handleCaseload(
      caseloadReq(token, "caseload_overview"),
      baseOptions(store, {
        cacheReader: cacheReaderReturning(
          "fresh",
          cachedBody,
          new Date(NOW.getTime() - 30_000),
        ),
        hydrateDisplayNamesImpl: hydrateSpy,
      }),
    );

    expect(res.status).toBe(200);
    expect(hydrateSpy).toHaveBeenCalledTimes(1);
    const body = (await res.json()) as CaseloadBody;
    expect(body.items[0]?.displayName).toBe("Hydrated Name");
  });

  it("serves the cache as-is when hydration throws (no 500, falls back to participantId)", async () => {
    const { store, seed } = makeStore();
    const token = seed();
    const cachedBody = buildCaseloadBody({
      specialistId: SPECIALIST_ID,
      queueId: "caseload_overview",
      queueCounts: { caseload_overview: 1 },
      cacheAgeSeconds: 0,
      configurationVersion: 0,
      items: [
        {
          ...buildCaseloadItem(),
          participantId: "p-1",
          displayName: null,
        },
      ],
    });
    const hydrateSpy = vi.fn(() => Promise.reject(new Error("SF unreachable")));

    const res = await handleCaseload(
      caseloadReq(token, "caseload_overview"),
      baseOptions(store, {
        cacheReader: cacheReaderReturning(
          "fresh",
          cachedBody,
          new Date(NOW.getTime() - 30_000),
        ),
        hydrateDisplayNamesImpl: hydrateSpy,
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as CaseloadBody;
    expect(body.items[0]?.displayName).toBeNull();
  });
});

// Minimal CaseloadItem shape for the warm-path hydration tests above. The
// score-derived fields are nulled out — these tests assert plumbing, not
// engine behavior.
function buildCaseloadItem(): Omit<
  CaseloadBody["items"][number],
  "participantId" | "displayName"
> {
  return {
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

// ── cold path ───────────────────────────────────────────────────────────────

describe("handleCaseload — cold path", () => {
  it("hydrates, audits caseload.hydrated, and writes one cache row per queue", async () => {
    const { store, seed } = makeStore();
    const token = seed();
    const scored = [
      makeScored(makeSnapshot("p-1", SPECIALIST_ID), makeEngineOutput("p-1")),
      makeScored(makeSnapshot("p-2", SPECIALIST_ID), makeEngineOutput("p-2")),
    ];
    const cacheWriter = vi.fn(() => Promise.resolve());
    const writeAudit = vi.fn(() => Promise.resolve({ id: "audit-1" }));

    const res = await handleCaseload(
      caseloadReq(token, "caseload_overview"),
      baseOptions(store, {
        cacheReader: cacheReaderReturning("miss", null, null),
        scoreCaseloadImpl: () => Promise.resolve(makeResult(scored)),
        cacheWriter,
        writeAudit,
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as CaseloadBody;
    expect(body.items).toHaveLength(2);
    expect(body.cacheAgeSeconds).toBe(0);
    expect(body.configurationVersion).toBe(1);

    // One audit row, BEFORE the response, with no PII in payload_metadata.
    expect(writeAudit).toHaveBeenCalledTimes(1);
    const entry = writeAudit.mock.calls[0]?.[1] as {
      actionType: string;
      outcome: string;
      payloadMetadata: Record<string, unknown>;
    };
    expect(entry.actionType).toBe("caseload.hydrated");
    expect(entry.outcome).toBe("SUCCESS");
    expect(entry.payloadMetadata).toEqual({
      queue_id: "caseload_overview",
      // The Demo stub config reports version 0; the handler floors it to 1
      // so the cache key satisfies the `caseload_cache.config_version > 0`
      // CHECK (P1C-02).
      config_version: 1,
      round_trips: 2,
      participant_count: 2,
      degraded_count: 0,
      queue_counts: {
        "caseload_overview": 2,
        "due_soon": 0,
        "never_successfully_contacted": 0,
        "check_ins_due_this_month": 0,
      },
    });

    // One cache row written per queue in the universe (4).
    expect(cacheWriter).toHaveBeenCalledTimes(4);
  });

  it("sorts within the queue by priority score descending, degraded rows last (BR-21)", async () => {
    const { store, seed } = makeStore();
    const token = seed();
    const scored = [
      makeScored(
        makeSnapshot("p-low", SPECIALIST_ID),
        makeEngineOutput("p-low", { priorityScore: 30 }),
      ),
      makeScored(makeSnapshot("p-degraded", SPECIALIST_ID), null),
      makeScored(
        makeSnapshot("p-high", SPECIALIST_ID),
        makeEngineOutput("p-high", { priorityScore: 90 }),
      ),
    ];

    const res = await handleCaseload(
      caseloadReq(token, "caseload_overview"),
      baseOptions(store, {
        cacheReader: cacheReaderReturning("miss", null, null),
        scoreCaseloadImpl: () => Promise.resolve(makeResult(scored)),
      }),
    );

    const body = (await res.json()) as CaseloadBody;
    expect(body.items.map((i) => i.participantId)).toEqual([
      "p-high",
      "p-low",
      "p-degraded",
    ]);
  });

  it("filters to the requested queue's predicate (BR-22)", async () => {
    const { store, seed } = makeStore();
    const token = seed();
    // p-due has a checkpoint 10 days out → member of `due_soon`;
    // p-far has none → not a member.
    const scored = [
      makeScored(
        makeSnapshot("p-due", SPECIALIST_ID, {
          enrollment: { dueDates: dueDatesWith(new Date("2026-05-25T12:00:00Z")) },
        }),
        makeEngineOutput("p-due"),
      ),
      makeScored(makeSnapshot("p-far", SPECIALIST_ID), makeEngineOutput("p-far")),
    ];

    const res = await handleCaseload(
      caseloadReq(token, "due_soon"),
      baseOptions(store, {
        cacheReader: cacheReaderReturning("miss", null, null),
        scoreCaseloadImpl: () => Promise.resolve(makeResult(scored)),
      }),
    );

    const body = (await res.json()) as CaseloadBody;
    expect(body.items.map((i) => i.participantId)).toEqual(["p-due"]);
    expect(body.queueCounts["due_soon"]).toBe(1);
    expect(body.queueCounts["caseload_overview"]).toBe(2);
  });

  it("treats a stale cache row as a miss and rehydrates", async () => {
    const { store, seed } = makeStore();
    const token = seed();
    const staleBody = buildCaseloadBody({
      specialistId: SPECIALIST_ID,
      queueId: "caseload_overview",
      queueCounts: {},
      cacheAgeSeconds: 0,
      configurationVersion: 0,
      items: [],
    });
    const scoreSpy = vi.fn(() =>
      Promise.resolve(
        makeResult([
          makeScored(makeSnapshot("p-1", SPECIALIST_ID), makeEngineOutput("p-1")),
        ]),
      ),
    );

    const res = await handleCaseload(
      caseloadReq(token, "caseload_overview"),
      baseOptions(store, {
        cacheReader: cacheReaderReturning(
          "stale",
          staleBody,
          new Date(NOW.getTime() - 999_000),
        ),
        scoreCaseloadImpl: scoreSpy,
      }),
    );

    expect(res.status).toBe(200);
    expect(scoreSpy).toHaveBeenCalledTimes(1);
  });

  it("resolves the BR-20 default queue when ?queue= is absent", async () => {
    const { store, seed } = makeStore();
    const token = seed();

    const res = await handleCaseload(
      caseloadReq(token),
      baseOptions(store, {
        cacheReader: cacheReaderReturning("miss", null, null),
        scoreCaseloadImpl: () => Promise.resolve(makeResult([])),
      }),
    );

    const body = (await res.json()) as CaseloadBody;
    expect(body.queue).toBe("check_ins_due_this_month");
  });
});

// ── error taxonomy ──────────────────────────────────────────────────────────

describe("handleCaseload — error taxonomy", () => {
  it("404 QUEUE_NOT_FOUND for an unknown ?queue= id, without hydrating", async () => {
    const { store, seed } = makeStore();
    const token = seed();
    const scoreSpy = vi.fn();

    const res = await handleCaseload(
      caseloadReq(token, "not-a-real-queue"),
      baseOptions(store, {
        cacheReader: cacheReaderReturning("miss", null, null),
        scoreCaseloadImpl: scoreSpy as never,
      }),
    );

    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe(
      "QUEUE_NOT_FOUND",
    );
    expect(scoreSpy).not.toHaveBeenCalled();
  });

  it("503 SF_UPSTREAM_UNAVAILABLE on a transient Salesforce fault", async () => {
    const { store, seed } = makeStore();
    const token = seed();

    const res = await handleCaseload(
      caseloadReq(token, "caseload_overview"),
      baseOptions(store, {
        cacheReader: cacheReaderReturning("miss", null, null),
        scoreCaseloadImpl: () =>
          Promise.reject(
            new SalesforceError("SF_NETWORK_TIMEOUT", "hydration timed out"),
          ),
      }),
    );

    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe(
      "SF_UPSTREAM_UNAVAILABLE",
    );
  });

  it("500 INTERNAL_ERROR on a Salesforce auth fault", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { store, seed } = makeStore();
    const token = seed();

    const res = await handleCaseload(
      caseloadReq(token, "caseload_overview"),
      baseOptions(store, {
        cacheReader: cacheReaderReturning("miss", null, null),
        scoreCaseloadImpl: () =>
          Promise.reject(
            new SalesforceError("SF_AUTH_FAILED", "token rejected"),
          ),
      }),
    );

    expect(res.status).toBe(500);
    expect(((await res.json()) as { code: string }).code).toBe(
      "INTERNAL_ERROR",
    );
    error.mockRestore();
  });

  it("still returns 200 when the cache write-through fails (best effort)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { store, seed } = makeStore();
    const token = seed();

    const res = await handleCaseload(
      caseloadReq(token, "caseload_overview"),
      baseOptions(store, {
        cacheReader: cacheReaderReturning("miss", null, null),
        scoreCaseloadImpl: () => Promise.resolve(makeResult([])),
        cacheWriter: () => Promise.reject(new Error("cache table unreachable")),
      }),
    );

    expect(res.status).toBe(200);
    warn.mockRestore();
  });
});
