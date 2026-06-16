import { hashToken, loadSessionConfig, mintToken } from "@anthos/auth";
import type { Role } from "@anthos/auth";
import { getCalibrationConfiguration, type Configuration } from "@anthos/domain";
import { SalesforceError } from "@anthos/integrations";
import type { DbOrTx } from "@anthos/persistence";
import { describe, expect, it, vi } from "vitest";

import type { CaseloadBody } from "../../src/caseload/dto.js";
import { handleRefreshCaseload } from "../../src/caseload/refresh-caseload.js";
import type { RefreshCaseloadHandlerOptions } from "../../src/caseload/refresh-caseload.js";
import type {
  ScoreCaseloadResult,
  ScoredParticipant,
} from "../../src/caseload/score-caseload.js";
import type {
  IdempotencyRecord,
  IdempotencyStatus,
  IdempotencyStore,
} from "../../src/idempotency/store.js";
import type { RateLimiter, RateLimitResult } from "../../src/ratelimit/index.js";
import type { SessionRecord, SessionStore } from "../../src/session/store.js";
import { makeEngineOutput, makeScored, makeSnapshot } from "./_fixtures.js";

// ── fixtures ────────────────────────────────────────────────────────────────

const SESSION_CONFIG = loadSessionConfig({});
const HOUR = 60 * 60 * 1000;
const SPECIALIST_ID = "0058K00000XYZAbQAO";
const IDEM_KEY = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-05-23T12:00:00Z");

// Test config — same shape as `getCalibrationConfiguration()` but flips
// `caseload_overview` (the `all_active` predicate that matches every
// participant) to the default queue. The live Demo default
// (`check_ins_due_this_month` with `successful_contact_overdue`) requires
// snapshots with ≥28-day-old successful contacts that line up with the
// current calendar month, which is hostile to fixture authoring. Keeping the
// queue universe intact (just flipping `isDefault`) preserves every other
// behaviour under test — counts, membership, per-queue cache writes.
function makeTestConfig(): Configuration {
  const live = getCalibrationConfiguration();
  const flipped: Configuration["queuePredicates"] = {};
  for (const [id, entry] of Object.entries(live.queuePredicates)) {
    flipped[id] = { ...entry, isDefault: id === "caseload_overview" };
  }
  return { ...live, queuePredicates: flipped };
}

const CONFIG = makeTestConfig();
const CONFIG_VERSION = Math.max(1, CONFIG.version);
const DEFAULT_QUEUE_ID = "caseload_overview";
// A non-DB sentinel — every DB-touching seam is faked, so `db` is never read.
const FAKE_DB = {} as unknown as DbOrTx;

// In-memory SessionStore — `withSession` resolves seeded rows by token hash.
function makeStore(): {
  store: SessionStore;
  seed: (role?: Role, specialistId?: string) => string;
} {
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
  function seed(role: Role = "SPECIALIST", specialistId: string = SPECIALIST_ID): string {
    n += 1;
    const token = mintToken();
    rows.set(hashToken(token), {
      id: `session-${n}`,
      specialistId,
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

// Fake RateLimiter. By default every call is allowed (matches the live
// behaviour of an empty rate_limits table on a first request); pass a
// `program` to script the per-call return so tests can simulate throttling.
// Captures call args so tests can assert the namespaced key shape.
interface FakeRateLimiter {
  limiter: RateLimiter;
  calls: Array<{ key: string; windowSeconds: number }>;
}

function makeRateLimiter(
  program: ReadonlyArray<RateLimitResult> = [],
): FakeRateLimiter {
  const calls: FakeRateLimiter["calls"] = [];
  let i = 0;
  const limiter: RateLimiter = {
    checkAndConsume(key, windowSeconds) {
      calls.push({ key, windowSeconds });
      const r = program[i] ?? { allowed: true };
      i += 1;
      return Promise.resolve(r);
    },
  };
  return { limiter, calls };
}

interface FakeIdemRow {
  key: string;
  specialistId: string;
  status: IdempotencyStatus;
  requestHash: string | null;
  responseStatusCode: number | null;
  responseBody: unknown;
  traceId: string | null;
  expiresAt: Date;
}

function makeIdemStore(): IdempotencyStore {
  const rows = new Map<string, FakeIdemRow>();
  return {
    acquire(input) {
      if (rows.has(input.key)) return Promise.resolve(null);
      const row: FakeIdemRow = {
        key: input.key,
        specialistId: input.specialistId,
        status: "IN_FLIGHT",
        requestHash: input.requestHash,
        responseStatusCode: null,
        responseBody: null,
        traceId: input.traceId,
        expiresAt: new Date(Date.now() + 24 * HOUR),
      };
      rows.set(input.key, row);
      return Promise.resolve({ ...row } as IdempotencyRecord);
    },
    get(key) {
      const row = rows.get(key);
      return Promise.resolve(row ? ({ ...row } as IdempotencyRecord) : null);
    },
    markCompleted(key, code, body) {
      const row = rows.get(key);
      if (row) {
        row.status = "COMPLETED";
        row.responseStatusCode = code;
        row.responseBody = body;
      }
      return Promise.resolve();
    },
    markFailedTerminal(key, code, body) {
      const row = rows.get(key);
      if (row) {
        row.status = "FAILED_TERMINAL";
        row.responseStatusCode = code;
        row.responseBody = body;
      }
      return Promise.resolve();
    },
    delete(key) {
      rows.delete(key);
      return Promise.resolve();
    },
    cleanupExpired() {
      return Promise.resolve(0);
    },
  };
}

function makeScoreCaseload(
  scored: ReadonlyArray<ScoredParticipant> = [
    makeScored(makeSnapshot("p-1", SPECIALIST_ID), makeEngineOutput("p-1")),
    makeScored(makeSnapshot("p-2", SPECIALIST_ID), makeEngineOutput("p-2")),
  ],
  roundTrips = 2,
): NonNullable<RefreshCaseloadHandlerOptions["scoreCaseloadImpl"]> {
  return vi.fn(
    () =>
      Promise.resolve({
        scored,
        roundTrips,
        hydratedAt: NOW,
        configuration: CONFIG,
        now: NOW,
      }) as Promise<ScoreCaseloadResult>,
  );
}

interface AuditCapture {
  audits: Array<{
    actionType: string;
    outcome: string;
    channel?: string;
    payloadMetadata?: Record<string, unknown>;
  }>;
  writer: NonNullable<RefreshCaseloadHandlerOptions["writeAudit"]>;
}

function makeAuditCapture(): AuditCapture {
  const audits: AuditCapture["audits"] = [];
  const writer: NonNullable<RefreshCaseloadHandlerOptions["writeAudit"]> = vi.fn(
    (_db, entry) => {
      audits.push({
        actionType: entry.actionType,
        outcome: entry.outcome,
        ...(entry.channel !== undefined ? { channel: entry.channel } : {}),
        ...(entry.payloadMetadata !== undefined
          ? { payloadMetadata: entry.payloadMetadata as Record<string, unknown> }
          : {}),
      });
      return Promise.resolve({ id: `audit-${audits.length}` });
    },
  );
  return { audits, writer };
}

// A cache reader that always reports the given freshness/payload pair.
function cacheReaderReturning(
  freshness: "fresh" | "stale" | "miss",
  payload: CaseloadBody | null,
  lastRefreshedAt: Date | null,
): NonNullable<RefreshCaseloadHandlerOptions["cacheReader"]> {
  return vi.fn(() => Promise.resolve({ freshness, payload, lastRefreshedAt }));
}

// A txRunner that simply invokes fn with the db — used to drive the
// transactional body in unit tests without a real DB. The plumbing under
// test is the audit-then-cache ORDER and the rollback contract, not Drizzle's
// transaction semantics themselves.
const inlineTxRunner: NonNullable<RefreshCaseloadHandlerOptions["txRunner"]> = (
  db,
  fn,
) => fn(db);

// Pass `null` for `idempotencyKey` to omit the header.
function refreshReq(
  token: string | undefined,
  idempotencyKey: string | null = IDEM_KEY,
  query?: Record<string, string>,
): Request {
  const headers = new Headers();
  if (token !== undefined) headers.set("Cookie", `anthos_session=${token}`);
  if (idempotencyKey !== null) headers.set("Idempotency-Key", idempotencyKey);
  const url = new URL("https://bff.test/api/v1/caseload/refresh");
  if (query) {
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  }
  return new Request(url, { method: "POST", headers });
}

function baseOptions(
  store: SessionStore,
  overrides: Partial<RefreshCaseloadHandlerOptions> = {},
): RefreshCaseloadHandlerOptions {
  const audit = overrides.writeAudit ?? makeAuditCapture().writer;
  return {
    store,
    sessionConfig: SESSION_CONFIG,
    idempotencyStore: makeIdemStore(),
    configuration: CONFIG,
    db: FAKE_DB,
    cacheReader: cacheReaderReturning("miss", null, null),
    cacheWriter: vi.fn(() => Promise.resolve()),
    writeAudit: audit,
    txRunner: inlineTxRunner,
    scoreCaseloadImpl: makeScoreCaseload(),
    rateLimiter: makeRateLimiter().limiter,
    now: () => NOW,
    ...overrides,
  };
}

// ── T1 / T2 / T3 — auth + idempotency gates ─────────────────────────────────

describe("handleRefreshCaseload — auth + idempotency gates", () => {
  it("T1: 401 AUTH_SESSION_INVALID when no session cookie is present", async () => {
    const { store } = makeStore();
    const scoreSpy = makeScoreCaseload();
    const writeAudit = vi.fn(() => Promise.resolve({ id: "a" }));
    const res = await handleRefreshCaseload(
      refreshReq(undefined),
      baseOptions(store, { scoreCaseloadImpl: scoreSpy, writeAudit }),
    );
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe(
      "AUTH_SESSION_INVALID",
    );
    expect(scoreSpy).not.toHaveBeenCalled();
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it("T2: 400 IDEMPOTENCY_KEY_REQUIRED when header is missing", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const scoreSpy = makeScoreCaseload();
    const res = await handleRefreshCaseload(
      refreshReq(token, null),
      baseOptions(store, { scoreCaseloadImpl: scoreSpy }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe(
      "IDEMPOTENCY_KEY_REQUIRED",
    );
    expect(scoreSpy).not.toHaveBeenCalled();
  });

  it("T3: 400 IDEMPOTENCY_KEY_INVALID when header is not a UUIDv4", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const res = await handleRefreshCaseload(
      refreshReq(token, "not-a-uuid"),
      baseOptions(store),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe(
      "IDEMPOTENCY_KEY_INVALID",
    );
  });
});

// ── T4 — drill-down rejection ──────────────────────────────────────────────

describe("handleRefreshCaseload — drill-down deferral (D2)", () => {
  it("T4: 422 VALIDATION_FAILED when ?specialistId= is present", async () => {
    const { store, seed } = makeStore();
    const token = seed("SUPERVISOR");
    const scoreSpy = makeScoreCaseload();
    const cacheWriter = vi.fn(() => Promise.resolve());
    const res = await handleRefreshCaseload(
      refreshReq(token, IDEM_KEY, { specialistId: "0058K00000QQQXXxQAO" }),
      baseOptions(store, { scoreCaseloadImpl: scoreSpy, cacheWriter }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      code: string;
      details?: { field?: string; reason?: string };
    };
    expect(body.code).toBe("VALIDATION_FAILED");
    expect(body.details?.field).toBe("specialistId");
    expect(body.details?.reason).toBe("drill_down_not_implemented");
    expect(scoreSpy).not.toHaveBeenCalled();
    expect(cacheWriter).not.toHaveBeenCalled();
  });
});

// ── T5 / T6 / T11 — happy paths ────────────────────────────────────────────

describe("handleRefreshCaseload — happy path", () => {
  it("T5: 200, audits caseload.refreshed BEFORE response, writes all queue cache rows, cacheAgeSeconds=0, no PII", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const scored = [
      makeScored(makeSnapshot("p-1", SPECIALIST_ID), makeEngineOutput("p-1")),
      makeScored(makeSnapshot("p-2", SPECIALIST_ID), makeEngineOutput("p-2")),
      makeScored(makeSnapshot("p-3", SPECIALIST_ID), makeEngineOutput("p-3")),
    ];
    const scoreSpy = makeScoreCaseload(scored, 3);
    const { audits, writer } = makeAuditCapture();
    // Capture call order so we can assert audit precedes cache writes — the
    // Pattern B / Immutable #5 invariant.
    const callOrder: string[] = [];
    const auditOrdered: NonNullable<RefreshCaseloadHandlerOptions["writeAudit"]> = (
      db,
      entry,
    ) => {
      callOrder.push("audit");
      return writer(db, entry);
    };
    const cacheWriterOrdered = vi.fn(() => {
      callOrder.push("cache");
      return Promise.resolve();
    });

    const res = await handleRefreshCaseload(
      refreshReq(token),
      baseOptions(store, {
        scoreCaseloadImpl: scoreSpy,
        writeAudit: auditOrdered,
        cacheWriter: cacheWriterOrdered,
        cacheReader: cacheReaderReturning("miss", null, null),
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as CaseloadBody;
    expect(body.specialistId).toBe(SPECIALIST_ID);
    expect(body.queue).toBe(DEFAULT_QUEUE_ID);
    expect(body.cacheAgeSeconds).toBe(0);
    expect(body.configurationVersion).toBe(CONFIG_VERSION);
    expect(body.items).toHaveLength(3);

    // Exactly one audit row, audited BEFORE any cache write.
    expect(audits).toHaveLength(1);
    expect(callOrder[0]).toBe("audit");
    expect(callOrder.slice(1).every((c) => c === "cache")).toBe(true);

    const audit = audits[0]!;
    expect(audit.actionType).toBe("caseload.refreshed");
    expect(audit.outcome).toBe("SUCCESS");
    expect(audit.channel).toBe("system");
    const meta = audit.payloadMetadata!;
    expect(meta["soql_query_id"]).toBe("score-caseload.bulk-hydrate.v1");
    expect(meta["participant_count_pre"]).toBeNull();
    expect(meta["participant_count_post"]).toBe(3);
    expect(meta["round_trips"]).toBe(3);
    expect(meta["config_version"]).toBe(CONFIG_VERSION);
    expect(typeof meta["elapsed_ms"]).toBe("number");
    expect(meta["queue_counts"]).toBeDefined();
    // No PII: no participant ids, names, addresses, DOBs anywhere in metadata.
    const metaJson = JSON.stringify(meta);
    expect(metaJson).not.toContain("p-1");
    expect(metaJson).not.toContain("p-2");
    expect(metaJson).not.toContain("p-3");

    // One cache write per queue in the universe.
    expect(cacheWriterOrdered).toHaveBeenCalledTimes(
      Object.keys(CONFIG.queuePredicates).length,
    );
  });

  it("T6: covers every queue in the M-CONFIG universe — counts + per-queue cache writes", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const cacheWriter = vi.fn(() => Promise.resolve());
    const writtenQueueIds = new Set<string>();
    const cacheWriterCapture: NonNullable<
      RefreshCaseloadHandlerOptions["cacheWriter"]
    > = (db, input) => {
      writtenQueueIds.add(input.queueId);
      return cacheWriter(db, input);
    };

    await handleRefreshCaseload(
      refreshReq(token),
      baseOptions(store, { cacheWriter: cacheWriterCapture }),
    );

    expect(writtenQueueIds).toEqual(new Set(Object.keys(CONFIG.queuePredicates)));
  });

  it("T11: empty caseload — 200, post-size 0, cache rows still written for every queue", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const scoreSpy = makeScoreCaseload([], 1);
    const { audits, writer } = makeAuditCapture();
    const cacheWriter = vi.fn(() => Promise.resolve());

    const res = await handleRefreshCaseload(
      refreshReq(token),
      baseOptions(store, {
        scoreCaseloadImpl: scoreSpy,
        writeAudit: writer,
        cacheWriter,
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as CaseloadBody;
    expect(body.items).toHaveLength(0);
    expect(audits[0]!.payloadMetadata!["participant_count_post"]).toBe(0);
    expect(cacheWriter).toHaveBeenCalledTimes(
      Object.keys(CONFIG.queuePredicates).length,
    );
  });
});

// ── T7 — idempotency replay ─────────────────────────────────────────────────

describe("handleRefreshCaseload — idempotency replay", () => {
  it("T7: a second request with the same key returns the stored response WITHOUT re-running the handler", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const idemStore = makeIdemStore();
    const scoreSpy = makeScoreCaseload();
    const writeAudit = vi.fn(() => Promise.resolve({ id: "a" }));
    const cacheWriter = vi.fn(() => Promise.resolve());

    const opts = baseOptions(store, {
      idempotencyStore: idemStore,
      scoreCaseloadImpl: scoreSpy,
      writeAudit,
      cacheWriter,
    });

    const first = await handleRefreshCaseload(refreshReq(token), opts);
    expect(first.status).toBe(200);
    const firstBody = await first.json();

    const second = await handleRefreshCaseload(refreshReq(token), opts);
    expect(second.status).toBe(200);
    const secondBody = await second.json();

    // Same response body returned from the idempotency store.
    expect(secondBody).toEqual(firstBody);
    // The X-Idempotent-Replay header marks the replay.
    expect(second.headers.get("X-Idempotent-Replay")).toBe("true");
    // Handler ran exactly once total.
    expect(scoreSpy).toHaveBeenCalledTimes(1);
    expect(writeAudit).toHaveBeenCalledTimes(1);
    expect(cacheWriter).toHaveBeenCalledTimes(
      Object.keys(CONFIG.queuePredicates).length,
    );
  });
});

// ── T8 / T9 — Salesforce failures ──────────────────────────────────────────

describe("handleRefreshCaseload — Salesforce failures", () => {
  it("T8: SF_NETWORK_TIMEOUT → 503 SF_UPSTREAM_UNAVAILABLE + FAILED audit with failure_phase=hydrate", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const scoreSpy = vi.fn(() =>
      Promise.reject(new SalesforceError("SF_NETWORK_TIMEOUT", "timeout")),
    ) as unknown as NonNullable<RefreshCaseloadHandlerOptions["scoreCaseloadImpl"]>;
    const { audits, writer } = makeAuditCapture();
    const cacheWriter = vi.fn(() => Promise.resolve());

    const res = await handleRefreshCaseload(
      refreshReq(token),
      baseOptions(store, {
        scoreCaseloadImpl: scoreSpy,
        writeAudit: writer,
        cacheWriter,
      }),
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("SF_UPSTREAM_UNAVAILABLE");

    expect(audits).toHaveLength(1);
    const audit = audits[0]!;
    expect(audit.actionType).toBe("caseload.refreshed");
    expect(audit.outcome).toBe("FAILED");
    const meta = audit.payloadMetadata!;
    expect(meta["failure_phase"]).toBe("hydrate");
    expect(meta["sf_code"]).toBe("SF_NETWORK_TIMEOUT");
    expect(typeof meta["elapsed_ms"]).toBe("number");

    // No cache write on the failure path.
    expect(cacheWriter).not.toHaveBeenCalled();
  });

  it("T9: non-transient SalesforceError (SF_AUTH_FAILED) → 500 INTERNAL_ERROR + FAILED audit row", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const scoreSpy = vi.fn(() =>
      Promise.reject(new SalesforceError("SF_AUTH_FAILED", "401")),
    ) as unknown as NonNullable<RefreshCaseloadHandlerOptions["scoreCaseloadImpl"]>;
    const { audits, writer } = makeAuditCapture();

    const res = await handleRefreshCaseload(
      refreshReq(token),
      baseOptions(store, { scoreCaseloadImpl: scoreSpy, writeAudit: writer }),
    );
    expect(res.status).toBe(500);
    expect(((await res.json()) as { code: string }).code).toBe("INTERNAL_ERROR");

    expect(audits).toHaveLength(1);
    expect(audits[0]!.outcome).toBe("FAILED");
    expect(audits[0]!.payloadMetadata!["sf_code"]).toBe("SF_AUTH_FAILED");
  });
});

// ── T10 — transaction rollback ──────────────────────────────────────────────

describe("handleRefreshCaseload — transaction rollback (BR-75 atomicity)", () => {
  // The Drizzle TX rollback itself is exercised by @anthos/persistence's own
  // tests; here we pin the handler's contract on a TX failure: 500 surfaces
  // and the idempotency key is released so a client retry can succeed.
  it("T10: cache write failure inside the TX → 500 + idempotency key released (5xx path)", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const idemStore = makeIdemStore();
    const deleteSpy = vi.spyOn(idemStore, "delete");
    const { writer } = makeAuditCapture();
    // Fail on the second cache write to simulate a mid-loop failure.
    let cacheCalls = 0;
    const cacheWriter = vi.fn(() => {
      cacheCalls += 1;
      if (cacheCalls === 2) {
        return Promise.reject(new Error("cache write boom"));
      }
      return Promise.resolve();
    });

    const res = await handleRefreshCaseload(
      refreshReq(token),
      baseOptions(store, {
        idempotencyStore: idemStore,
        writeAudit: writer,
        cacheWriter,
      }),
    );

    expect(res.status).toBe(500);
    expect(((await res.json()) as { code: string }).code).toBe("INTERNAL_ERROR");
    // 5xx path — the idempotency middleware MUST release the key so a retry
    // can succeed (TR-WRITE-2b).
    expect(deleteSpy).toHaveBeenCalledWith(IDEM_KEY);
  });
});

// ── T12 — pre-size capture ──────────────────────────────────────────────────

describe("handleRefreshCaseload — pre-size audit metadata", () => {
  it("T12a: participant_count_pre is the cached default-queue item count on a cache hit", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const cachedBody: CaseloadBody = {
      specialistId: SPECIALIST_ID,
      queue: DEFAULT_QUEUE_ID,
      sort: "priority_desc",
      queueCounts: { [DEFAULT_QUEUE_ID]: 5 },
      cacheAgeSeconds: 30,
      configurationVersion: CONFIG_VERSION,
      items: [
        // Five participant items, shape-thin — the handler only reads `.length`.
        ...Array.from({ length: 5 }, () => ({}) as never),
      ],
    };
    const { audits, writer } = makeAuditCapture();

    await handleRefreshCaseload(
      refreshReq(token),
      baseOptions(store, {
        cacheReader: cacheReaderReturning("fresh", cachedBody, NOW),
        writeAudit: writer,
      }),
    );
    expect(audits[0]!.payloadMetadata!["participant_count_pre"]).toBe(5);
  });

  it("T12b: participant_count_pre is null on cache miss", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { audits, writer } = makeAuditCapture();
    await handleRefreshCaseload(
      refreshReq(token),
      baseOptions(store, {
        cacheReader: cacheReaderReturning("miss", null, null),
        writeAudit: writer,
      }),
    );
    expect(audits[0]!.payloadMetadata!["participant_count_pre"]).toBeNull();
  });

  it("T12c: pre-size read failure is best-effort — refresh still succeeds with null", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const cacheReader = vi.fn(() => Promise.reject(new Error("cache read down")));
    const { audits, writer } = makeAuditCapture();

    const res = await handleRefreshCaseload(
      refreshReq(token),
      baseOptions(store, { cacheReader, writeAudit: writer }),
    );
    expect(res.status).toBe(200);
    expect(audits[0]!.payloadMetadata!["participant_count_pre"]).toBeNull();
  });
});

// ── T13 — PII firewall integration ──────────────────────────────────────────

describe("handleRefreshCaseload — Pattern B PII firewall", () => {
  it("T13: the real assertNoPii in writeAuditEntry does not throw on our metadata shape", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    // Use the real writer (it reaches the DB via Drizzle.insert which we stub).
    const { writeAuditEntry } = await import("@anthos/audit");
    // Fake DB that records the row built by writeAuditEntry without persisting.
    const insertedRows: unknown[] = [];
    const fakeDb = {
      insert: () => ({
        values: (row: unknown) => ({
          returning: () => {
            insertedRows.push(row);
            return Promise.resolve([{ id: "audit-pii-test" }]);
          },
        }),
      }),
    } as unknown as DbOrTx;

    const res = await handleRefreshCaseload(
      refreshReq(token),
      baseOptions(store, {
        db: fakeDb,
        writeAudit: writeAuditEntry,
        cacheReader: cacheReaderReturning("miss", null, null),
        cacheWriter: vi.fn(() => Promise.resolve()),
      }),
    );
    expect(res.status).toBe(200);
    expect(insertedRows).toHaveLength(1);
  });
});

// ── T14 — response headers ──────────────────────────────────────────────────

describe("handleRefreshCaseload — response headers", () => {
  it("T14: 200 carries Cache-Control: no-store and X-Trace-Id that matches the inbound trace", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const inboundTrace = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const headers = new Headers();
    headers.set("Cookie", `anthos_session=${token}`);
    headers.set("Idempotency-Key", IDEM_KEY);
    headers.set("X-Trace-Id", inboundTrace);
    const req = new Request("https://bff.test/api/v1/caseload/refresh", {
      method: "POST",
      headers,
    });

    const res = await handleRefreshCaseload(req, baseOptions(store));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Trace-Id")).toBe(inboundTrace);
  });
});

// ── T15 / T16 / T17 / T18 — rate limit (TR-SF-9 / BR-76, P1G-02) ────────────

describe("handleRefreshCaseload — rate limit (TR-SF-9 / BR-76)", () => {
  it("T15: a throttled request returns 429 RATE_LIMITED with Retry-After + canonical envelope, writes a FAILED audit row BEFORE the response, and skips SF + cache writes", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { limiter, calls } = makeRateLimiter([
      { allowed: false, retryAfterSeconds: 30 },
    ]);
    const scoreSpy = makeScoreCaseload();
    const cacheWriter = vi.fn(() => Promise.resolve());
    const { audits, writer } = makeAuditCapture();

    const res = await handleRefreshCaseload(
      refreshReq(token),
      baseOptions(store, {
        rateLimiter: limiter,
        scoreCaseloadImpl: scoreSpy,
        writeAudit: writer,
        cacheWriter,
      }),
    );

    // 429 envelope per API §9.2.1: { code, message, traceId, details: { retryAfterSeconds, limit } }.
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("30");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Trace-Id")).not.toBeNull();
    const body = (await res.json()) as {
      code: string;
      message: string;
      traceId: string;
      details: { retryAfterSeconds: number; limit: number };
    };
    expect(body.code).toBe("RATE_LIMITED");
    expect(typeof body.message).toBe("string");
    expect(body.details.retryAfterSeconds).toBe(30);
    expect(body.details.limit).toBe(1);

    // The limiter was consulted exactly once, with the namespaced scope key.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.key).toBe(`caseload.refresh:${SPECIALIST_ID}`);
    expect(calls[0]!.windowSeconds).toBe(30);

    // Audit row: caseload.refreshed FAILED with reason rate_limited; no PII.
    expect(audits).toHaveLength(1);
    const audit = audits[0]!;
    expect(audit.actionType).toBe("caseload.refreshed");
    expect(audit.outcome).toBe("FAILED");
    expect(audit.channel).toBe("system");
    const meta = audit.payloadMetadata!;
    expect(meta["reason"]).toBe("rate_limited");
    expect(meta["window_seconds"]).toBe(30);
    expect(meta["retry_after_seconds"]).toBe(30);

    // No SF round-trip, no cache write on the throttled path.
    expect(scoreSpy).not.toHaveBeenCalled();
    expect(cacheWriter).not.toHaveBeenCalled();
  });

  it("T16: per-specialist key isolation — two specialists each get their own first-call budget", async () => {
    const { store, seed } = makeStore();
    const SPECIALIST_A = "0058K00000AAAAAAAA";
    const SPECIALIST_B = "0058K00000BBBBBBBB";
    const tokenA = seed("SPECIALIST", SPECIALIST_A);
    const tokenB = seed("SPECIALIST", SPECIALIST_B);
    const { limiter, calls } = makeRateLimiter();

    const resA = await handleRefreshCaseload(
      refreshReq(tokenA, "11111111-1111-4111-8111-aaaaaaaaaaaa"),
      baseOptions(store, { rateLimiter: limiter }),
    );
    const resB = await handleRefreshCaseload(
      refreshReq(tokenB, "11111111-1111-4111-8111-bbbbbbbbbbbb"),
      baseOptions(store, { rateLimiter: limiter }),
    );

    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
    // Two distinct namespaced keys — one per specialist.
    expect(calls.map((c) => c.key)).toEqual([
      `caseload.refresh:${SPECIALIST_A}`,
      `caseload.refresh:${SPECIALIST_B}`,
    ]);
  });

  it("T17: idempotent replay of a stored key does NOT consume a token (withIdempotency short-circuits before the core)", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const idemStore = makeIdemStore();
    const { limiter, calls } = makeRateLimiter();
    const scoreSpy = makeScoreCaseload();
    const writeAudit = vi.fn(() => Promise.resolve({ id: "a" }));

    const opts = baseOptions(store, {
      rateLimiter: limiter,
      idempotencyStore: idemStore,
      scoreCaseloadImpl: scoreSpy,
      writeAudit,
    });

    const first = await handleRefreshCaseload(refreshReq(token), opts);
    const second = await handleRefreshCaseload(refreshReq(token), opts);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.headers.get("X-Idempotent-Replay")).toBe("true");
    // Core ran once → limiter consumed once → replay was free.
    expect(calls).toHaveLength(1);
    expect(scoreSpy).toHaveBeenCalledTimes(1);
    expect(writeAudit).toHaveBeenCalledTimes(1);
  });

  it("T18: a missing retryAfterSeconds from the limiter falls back to the window (30s)", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { limiter } = makeRateLimiter([{ allowed: false }]);
    const { audits, writer } = makeAuditCapture();

    const res = await handleRefreshCaseload(
      refreshReq(token),
      baseOptions(store, { rateLimiter: limiter, writeAudit: writer }),
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("30");
    expect(audits[0]!.payloadMetadata!["retry_after_seconds"]).toBe(30);
  });
});
