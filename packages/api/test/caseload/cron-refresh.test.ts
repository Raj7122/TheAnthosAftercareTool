// Unit tests for the P1G-04 nightly self-heal hard-refresh cron worker
// (TR-SF-8 / F-16). The cron's per-tick contract:
//
//   • Enumerate specialists from Salesforce, filter to local-02:00, refresh
//     each via the shared `executeCaseloadRefresh` engine.
//   • System-initiated — bypasses the manual rate limit (P1G-02 / TR-SF-9)
//     by entering the engine directly, NOT by smuggling a header.
//   • Per-(specialist, scheduled-run) deterministic UUIDv5 idempotency key;
//     a re-invoke of the same tick collapses to the same row.
//   • Per-specialist failure isolation: one SF error or DB hiccup never
//     blocks the rest of the tick (ticket AC §3).
//   • Audit `actionType: "caseload.refresh.cron"`, `channel: "system"`,
//     `payloadMetadata.trigger: "cron"`.

import type { DbOrTx } from "@anthos/persistence";
import { SalesforceError } from "@anthos/integrations";
import type {
  SalesforceSpecialist,
  SoqlQueryClient,
} from "@anthos/integrations";
import type { StructuredLogger } from "@anthos/logging";
import { getCalibrationConfiguration, type Configuration } from "@anthos/domain";
import { describe, expect, it, vi } from "vitest";

import type { CaseloadBody } from "../../src/caseload/dto.js";
import {
  CRON_SPECIALIST_REFRESH_DEFAULT_TIMEZONE,
  CRON_SPECIALIST_REFRESH_TARGET_LOCAL_HOUR,
  runNightlyCaseloadRefreshCron,
} from "../../src/caseload/cron-refresh.js";
import type { NightlyCaseloadRefreshCronOptions } from "../../src/caseload/cron-refresh.js";
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

import { makeEngineOutput, makeScored, makeSnapshot } from "./_fixtures.js";

// ── fixtures ────────────────────────────────────────────────────────────────

const SPECIALIST_A = "0058K00000AAAAAAAA";
const SPECIALIST_B = "0058K00000BBBBBBBB";
const SPECIALIST_C = "0058K00000CCCCCCCC";

// 06:00 UTC on a date in Eastern Standard Time (Jan = no DST). 06:00 UTC −
// 5h = 01:00 ET on 2026-01-15.
const NOW_OFF_HOUR_ET = new Date("2026-01-15T06:00:00Z");
// 07:00 UTC on the same date — 02:00 ET, the target hour.
const NOW_TARGET_HOUR_ET = new Date("2026-01-15T07:00:00Z");
// 06:00 UTC during DST (Jul) — Eastern Daylight Time = UTC-4, so 06:00 UTC
// is 02:00 EDT. Pins the IANA DST handling: a fixed UTC instant maps to
// different local hours across DST boundaries.
const NOW_TARGET_HOUR_EDT = new Date("2026-07-15T06:00:00Z");

const FAKE_DB = {} as unknown as DbOrTx;

function makeTestConfig(): Configuration {
  const live = getCalibrationConfiguration();
  const flipped: Configuration["queuePredicates"] = {};
  for (const [id, entry] of Object.entries(live.queuePredicates)) {
    flipped[id] = { ...entry, isDefault: id === "caseload_overview" };
  }
  return { ...live, queuePredicates: flipped };
}

const CONFIG = makeTestConfig();

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

interface CapturingIdemStore {
  store: IdempotencyStore;
  rows: Map<string, FakeIdemRow>;
}

function makeIdemStore(): CapturingIdemStore {
  const rows = new Map<string, FakeIdemRow>();
  const HOUR = 60 * 60 * 1000;
  const store: IdempotencyStore = {
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
  return { store, rows };
}

interface AuditCapture {
  audits: Array<{
    specialistId: string;
    actionType: string;
    outcome: string;
    channel?: string;
    traceId?: string;
    payloadMetadata?: Record<string, unknown>;
  }>;
  writer: NonNullable<RefreshCaseloadHandlerOptions["writeAudit"]>;
}

function makeAuditCapture(): AuditCapture {
  const audits: AuditCapture["audits"] = [];
  const writer: NonNullable<RefreshCaseloadHandlerOptions["writeAudit"]> = vi.fn(
    (_db, entry) => {
      audits.push({
        specialistId: entry.specialistId,
        actionType: entry.actionType,
        outcome: entry.outcome,
        ...(entry.channel !== undefined ? { channel: entry.channel } : {}),
        ...(entry.traceId !== undefined ? { traceId: entry.traceId } : {}),
        ...(entry.payloadMetadata !== undefined
          ? { payloadMetadata: entry.payloadMetadata as Record<string, unknown> }
          : {}),
      });
      return Promise.resolve({ id: `audit-${audits.length}` });
    },
  );
  return { audits, writer };
}

function makeScoreCaseload(
  scored: ReadonlyArray<ScoredParticipant> = [
    makeScored(makeSnapshot("p-1", SPECIALIST_A), makeEngineOutput("p-1")),
  ],
  roundTrips = 1,
): NonNullable<RefreshCaseloadHandlerOptions["scoreCaseloadImpl"]> {
  return vi.fn(
    () =>
      Promise.resolve({
        scored,
        roundTrips,
        hydratedAt: NOW_TARGET_HOUR_ET,
        configuration: CONFIG,
        now: NOW_TARGET_HOUR_ET,
      }) as Promise<ScoreCaseloadResult>,
  );
}

const inlineTxRunner: NonNullable<RefreshCaseloadHandlerOptions["txRunner"]> = (
  db,
  fn,
) => fn(db);

function noopLogger(): StructuredLogger {
  const log: StructuredLogger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => log,
  };
  return log;
}

// Static SF SOQL client — never queried in these tests because we inject
// `listSpecialists` directly. A defensive no-op so an accidental query path
// surfaces an obvious test failure rather than touching the network.
const NEVER_QUERIED_SF_CLIENT: SoqlQueryClient = {
  query: () =>
    Promise.reject(new Error("test bug: cron should inject listSpecialists")),
};

function makeListSpecialists(
  result: ReadonlyArray<SalesforceSpecialist>,
): NonNullable<NightlyCaseloadRefreshCronOptions["listSpecialists"]> {
  return vi.fn(() => Promise.resolve(result));
}

function baseOptions(
  overrides: Partial<NightlyCaseloadRefreshCronOptions> = {},
): NightlyCaseloadRefreshCronOptions {
  const audit = overrides.refreshOptions?.writeAudit ?? makeAuditCapture().writer;
  // Build the inner refreshOptions BEFORE spreading overrides so an override
  // that only specifies (e.g.) `scoreCaseloadImpl` merges into the full
  // default seam set rather than replacing it wholesale.
  const refreshOptions: RefreshCaseloadHandlerOptions = {
    configuration: CONFIG,
    db: FAKE_DB,
    cacheReader: vi.fn(() =>
      Promise.resolve({ freshness: "miss" as const, payload: null, lastRefreshedAt: null }),
    ),
    cacheWriter: vi.fn(() => Promise.resolve()),
    writeAudit: audit,
    txRunner: inlineTxRunner,
    scoreCaseloadImpl: makeScoreCaseload(),
    now: () => NOW_TARGET_HOUR_ET,
    ...overrides.refreshOptions,
  };
  // Spread overrides FIRST so explicit defaults below win for the keys we
  // always need to pin (sfClient + db + logger), and `refreshOptions` is the
  // carefully-merged object above (not the partial in `overrides`).
  return {
    sfClient: NEVER_QUERIED_SF_CLIENT,
    listSpecialists: makeListSpecialists([]),
    permissionSetNames: ["Anthos_Specialist"],
    idempotencyStore: makeIdemStore().store,
    db: FAKE_DB,
    logger: noopLogger(),
    traceIdFactory: () => "00000000-0000-4000-8000-000000000001",
    ...overrides,
    refreshOptions,
  };
}

// ── T1: TZ filter — only specialists whose local hour matches the target ───

describe("runNightlyCaseloadRefreshCron — local-hour filter", () => {
  it("T1: at 06:00 UTC (= 01:00 ET, NOT 02:00 ET), no NYC specialist is refreshed", async () => {
    const list = makeListSpecialists([
      { specialistId: SPECIALIST_A, timezone: "America/New_York" },
      { specialistId: SPECIALIST_B, timezone: "America/New_York" },
    ]);
    const scoreSpy = makeScoreCaseload();
    const result = await runNightlyCaseloadRefreshCron(
      baseOptions({
        now: () => NOW_OFF_HOUR_ET,
        listSpecialists: list,
        refreshOptions: { scoreCaseloadImpl: scoreSpy },
      }),
    );
    expect(result.specialistsEnumerated).toBe(2);
    expect(result.specialistsConsidered).toBe(0);
    expect(result.specialistsRefreshed).toBe(0);
    expect(scoreSpy).not.toHaveBeenCalled();
    // Per-specialist outcomes carry the actual local hour so the tick log
    // can surface "why nothing fired this tick".
    const offHour = result.outcomes.filter(
      (o) => o.status === "SKIPPED_OFF_HOUR",
    );
    expect(offHour).toHaveLength(2);
  });

  it("T2: at 07:00 UTC (= 02:00 ET, target hour), both NYC specialists refresh", async () => {
    const list = makeListSpecialists([
      { specialistId: SPECIALIST_A, timezone: "America/New_York" },
      { specialistId: SPECIALIST_B, timezone: "America/New_York" },
    ]);
    const scoreSpy = makeScoreCaseload();
    const result = await runNightlyCaseloadRefreshCron(
      baseOptions({
        now: () => NOW_TARGET_HOUR_ET,
        listSpecialists: list,
        refreshOptions: { scoreCaseloadImpl: scoreSpy },
      }),
    );
    expect(result.specialistsConsidered).toBe(2);
    expect(result.specialistsRefreshed).toBe(2);
    expect(scoreSpy).toHaveBeenCalledTimes(2);
    expect(scoreSpy).toHaveBeenNthCalledWith(1, SPECIALIST_A, expect.anything());
    expect(scoreSpy).toHaveBeenNthCalledWith(2, SPECIALIST_B, expect.anything());
  });

  it("T3: at 06:00 UTC in July (= 02:00 EDT during DST, target hour), the NYC specialist refreshes — IANA TZ ids handle DST correctly", async () => {
    const list = makeListSpecialists([
      { specialistId: SPECIALIST_A, timezone: "America/New_York" },
    ]);
    const result = await runNightlyCaseloadRefreshCron(
      baseOptions({
        now: () => NOW_TARGET_HOUR_EDT,
        listSpecialists: list,
      }),
    );
    expect(result.specialistsRefreshed).toBe(1);
  });

  it("T4: at the target NYC hour, a Los Angeles specialist is SKIPPED — independent local clocks", async () => {
    const list = makeListSpecialists([
      { specialistId: SPECIALIST_A, timezone: "America/New_York" },
      { specialistId: SPECIALIST_B, timezone: "America/Los_Angeles" },
    ]);
    const result = await runNightlyCaseloadRefreshCron(
      baseOptions({
        now: () => NOW_TARGET_HOUR_ET,
        listSpecialists: list,
      }),
    );
    expect(result.specialistsRefreshed).toBe(1);
    const refreshedIds = result.outcomes
      .filter((o) => o.status === "REFRESHED")
      .map((o) => o.specialistId);
    expect(refreshedIds).toEqual([SPECIALIST_A]);
  });

  it("T5: empty timezone falls back to America/New_York (ticket §Notes default)", async () => {
    const list = makeListSpecialists([
      { specialistId: SPECIALIST_A, timezone: "" },
    ]);
    // Off-hour for explicit-NY = off-hour for fallback-NY. Confirms the
    // fallback is wired to the same zone.
    const offHourResult = await runNightlyCaseloadRefreshCron(
      baseOptions({
        now: () => NOW_OFF_HOUR_ET,
        listSpecialists: list,
      }),
    );
    expect(offHourResult.specialistsRefreshed).toBe(0);

    const onHourResult = await runNightlyCaseloadRefreshCron(
      baseOptions({
        now: () => NOW_TARGET_HOUR_ET,
        listSpecialists: list,
      }),
    );
    expect(onHourResult.specialistsRefreshed).toBe(1);
    // Sanity: the exported constant pins the contract.
    expect(CRON_SPECIALIST_REFRESH_DEFAULT_TIMEZONE).toBe("America/New_York");
    expect(CRON_SPECIALIST_REFRESH_TARGET_LOCAL_HOUR).toBe(2);
  });

  it("T6: a non-empty TZ is used verbatim — non-NYC specialists are not coerced to NYC", async () => {
    const list = makeListSpecialists([
      { specialistId: SPECIALIST_A, timezone: "America/Los_Angeles" },
    ]);
    // 02:00 PST in January = 10:00 UTC (PST = UTC-8). Pins that an LA
    // specialist matches at 10:00 UTC, NOT at the NYC 07:00 UTC instant
    // that T2 exercised.
    const resultLocal02PST = await runNightlyCaseloadRefreshCron(
      baseOptions({
        now: () => new Date("2026-01-15T10:00:00Z"),
        listSpecialists: list,
      }),
    );
    expect(resultLocal02PST.specialistsRefreshed).toBe(1);
  });
});

// ── T_DST: spring-forward / fall-back pinning ──────────────────────────────

describe("runNightlyCaseloadRefreshCron — DST transitions (America/New_York)", () => {
  it("T_DST_SPRING: on spring-forward night, no 02:xx exists locally — NYC specialists are skipped (known one-night-per-year miss)", async () => {
    // 2026-03-08 02:00 EST never happens — clock jumps 01:59 → 03:00.
    // 07:00 UTC that night maps to LOCAL 03:00 in America/New_York.
    const list = makeListSpecialists([
      { specialistId: SPECIALIST_A, timezone: "America/New_York" },
    ]);
    const result = await runNightlyCaseloadRefreshCron(
      baseOptions({
        now: () => new Date("2026-03-08T07:00:00Z"),
        listSpecialists: list,
      }),
    );
    expect(result.specialistsRefreshed).toBe(0);
    expect(result.outcomes[0]?.status).toBe("SKIPPED_OFF_HOUR");
    const skip = result.outcomes[0];
    if (skip?.status === "SKIPPED_OFF_HOUR") {
      // Local 03:00 (the post-spring-forward hour), confirming the skip
      // is by hour-mismatch, not by error.
      expect(skip.localHour).toBe(3);
    }
  });

  it("T_DST_FALL: on fall-back night, the cron fires once at the LOCAL 02:00 tick (post-transition EST)", async () => {
    // 2026-11-01 fall-back: at 02:00 EDT the clock jumps back to 01:00 EST,
    // so the local 01:xx hour repeats but local 02:00 happens exactly once
    // — at 07:00 UTC (= 02:00 EST after the fall-back). The 06:00 UTC tick
    // maps to 01:00 EST (post-transition, the second 01 of the night) and
    // does NOT match the target hour; the 07:00 UTC tick is the one that
    // refreshes.
    const list = makeListSpecialists([
      { specialistId: SPECIALIST_A, timezone: "America/New_York" },
    ]);
    const offHour = await runNightlyCaseloadRefreshCron(
      baseOptions({
        now: () => new Date("2026-11-01T06:00:00Z"),
        listSpecialists: list,
      }),
    );
    expect(offHour.specialistsRefreshed).toBe(0);

    const onHour = await runNightlyCaseloadRefreshCron(
      baseOptions({
        now: () => new Date("2026-11-01T07:00:00Z"),
        listSpecialists: list,
      }),
    );
    expect(onHour.specialistsRefreshed).toBe(1);
  });
});

// ── T7: audit shape — cron and manual share the same spec action_type, ────
//        differentiated via payloadMetadata.trigger (per API §11.6 catalog;
//        no `caseload.*` wildcard, so a new `caseload.refresh.cron` string
//        was not added).
describe("runNightlyCaseloadRefreshCron — audit shape", () => {
  it("T7: SUCCESS audit row uses the spec-blessed actionType=caseload.refreshed, channel=system, payloadMetadata.trigger=cron", async () => {
    const list = makeListSpecialists([
      { specialistId: SPECIALIST_A, timezone: "America/New_York" },
    ]);
    const { audits, writer } = makeAuditCapture();
    await runNightlyCaseloadRefreshCron(
      baseOptions({
        now: () => NOW_TARGET_HOUR_ET,
        listSpecialists: list,
        refreshOptions: {
          writeAudit: writer,
        },
      }),
    );
    expect(audits).toHaveLength(1);
    const audit = audits[0]!;
    expect(audit.specialistId).toBe(SPECIALIST_A);
    expect(audit.actionType).toBe("caseload.refreshed");
    expect(audit.outcome).toBe("SUCCESS");
    expect(audit.channel).toBe("system");
    const meta = audit.payloadMetadata!;
    expect(meta["trigger"]).toBe("cron");
    expect(meta["soql_query_id"]).toBe("score-caseload.bulk-hydrate.v1");
    expect(meta["participant_count_post"]).toBe(1);
    // No PII — the participant id from the snapshot must not leak into the
    // metadata (the per-queue counts and ids stay structural).
    const metaJson = JSON.stringify(meta);
    expect(metaJson).not.toContain("p-1");
    // The trace_id stamped on the audit row matches the per-specialist
    // trace the worker minted, NOT a request-scoped trace.
    expect(audit.traceId).toBe("00000000-0000-4000-8000-000000000001");
  });

  it("T8: SalesforceError → FAILED audit with actionType=caseload.refreshed, failure_phase=hydrate, trigger=cron", async () => {
    const list = makeListSpecialists([
      { specialistId: SPECIALIST_A, timezone: "America/New_York" },
    ]);
    const { audits, writer } = makeAuditCapture();
    const scoreSpy = vi.fn(() =>
      Promise.reject(new SalesforceError("SF_NETWORK_TIMEOUT", "timeout")),
    ) as unknown as NonNullable<RefreshCaseloadHandlerOptions["scoreCaseloadImpl"]>;
    await runNightlyCaseloadRefreshCron(
      baseOptions({
        now: () => NOW_TARGET_HOUR_ET,
        listSpecialists: list,
        refreshOptions: {
          writeAudit: writer,
          scoreCaseloadImpl: scoreSpy,
        },
      }),
    );
    expect(audits).toHaveLength(1);
    const audit = audits[0]!;
    expect(audit.actionType).toBe("caseload.refreshed");
    expect(audit.outcome).toBe("FAILED");
    expect(audit.channel).toBe("system");
    const meta = audit.payloadMetadata!;
    expect(meta["trigger"]).toBe("cron");
    expect(meta["failure_phase"]).toBe("hydrate");
    expect(meta["sf_code"]).toBe("SF_NETWORK_TIMEOUT");
  });
});

// ── T9 / T10: idempotency — deterministic key + replay-no-op ───────────────

describe("runNightlyCaseloadRefreshCron — idempotency", () => {
  it("T9: a second cron tick at the same scheduled-run-ISO skips an already-refreshed specialist", async () => {
    const list = makeListSpecialists([
      { specialistId: SPECIALIST_A, timezone: "America/New_York" },
    ]);
    const { store } = makeIdemStore();
    const scoreSpy = makeScoreCaseload();

    const tick1 = await runNightlyCaseloadRefreshCron(
      baseOptions({
        now: () => NOW_TARGET_HOUR_ET,
        listSpecialists: list,
        idempotencyStore: store,
        refreshOptions: { scoreCaseloadImpl: scoreSpy },
      }),
    );
    expect(tick1.specialistsRefreshed).toBe(1);
    expect(scoreSpy).toHaveBeenCalledTimes(1);

    const tick2 = await runNightlyCaseloadRefreshCron(
      baseOptions({
        now: () => NOW_TARGET_HOUR_ET,
        listSpecialists: list,
        idempotencyStore: store,
        refreshOptions: { scoreCaseloadImpl: scoreSpy },
      }),
    );
    expect(tick2.specialistsRefreshed).toBe(0);
    expect(tick2.specialistsSkippedIdempotent).toBe(1);
    // The refresh engine ran exactly once across both ticks — the second
    // tick short-circuited at the idempotency check.
    expect(scoreSpy).toHaveBeenCalledTimes(1);
  });

  it("T10: a different tick (next hour, same specialist) is NOT skipped — keys are tick-scoped, not specialist-scoped", async () => {
    const list = makeListSpecialists([
      { specialistId: SPECIALIST_A, timezone: "America/New_York" },
    ]);
    const { store } = makeIdemStore();
    const scoreSpy = makeScoreCaseload();
    // Pin a NYC TZ + a non-NYC TZ so the same specialist refreshes at two
    // different UTC instants (Both at local 02:00). Simpler: re-run at the
    // EDT target hour, which is the same specialist in summer.
    await runNightlyCaseloadRefreshCron(
      baseOptions({
        now: () => NOW_TARGET_HOUR_ET,
        listSpecialists: list,
        idempotencyStore: store,
        refreshOptions: { scoreCaseloadImpl: scoreSpy },
      }),
    );
    await runNightlyCaseloadRefreshCron(
      baseOptions({
        now: () => NOW_TARGET_HOUR_EDT,
        listSpecialists: list,
        idempotencyStore: store,
        refreshOptions: { scoreCaseloadImpl: scoreSpy },
      }),
    );
    // Two distinct ticks → two distinct keys → two refreshes.
    expect(scoreSpy).toHaveBeenCalledTimes(2);
  });
});

// ── T11: failure isolation — one specialist's failure doesn't block others ─

describe("runNightlyCaseloadRefreshCron — failure isolation (ticket AC §3)", () => {
  it("T11: a SalesforceError for specialist A does not block specialist B from refreshing in the same tick", async () => {
    const list = makeListSpecialists([
      { specialistId: SPECIALIST_A, timezone: "America/New_York" },
      { specialistId: SPECIALIST_B, timezone: "America/New_York" },
    ]);
    let callCount = 0;
    const scoreSpy = vi.fn(() => {
      callCount += 1;
      if (callCount === 1) {
        return Promise.reject(
          new SalesforceError("SF_NETWORK_TIMEOUT", "timeout"),
        );
      }
      return Promise.resolve({
        scored: [makeScored(makeSnapshot("p-1", SPECIALIST_B), makeEngineOutput("p-1"))],
        roundTrips: 1,
        hydratedAt: NOW_TARGET_HOUR_ET,
        configuration: CONFIG,
        now: NOW_TARGET_HOUR_ET,
      } as ScoreCaseloadResult);
    }) as unknown as NonNullable<RefreshCaseloadHandlerOptions["scoreCaseloadImpl"]>;

    const result = await runNightlyCaseloadRefreshCron(
      baseOptions({
        now: () => NOW_TARGET_HOUR_ET,
        listSpecialists: list,
        refreshOptions: { scoreCaseloadImpl: scoreSpy },
      }),
    );
    expect(result.specialistsConsidered).toBe(2);
    expect(result.specialistsRefreshed).toBe(1);
    expect(result.specialistsFailed).toBe(1);
    const failedIds = result.outcomes
      .filter((o) => o.status === "FAILED")
      .map((o) => o.specialistId);
    const refreshedIds = result.outcomes
      .filter((o) => o.status === "REFRESHED")
      .map((o) => o.specialistId);
    expect(failedIds).toEqual([SPECIALIST_A]);
    expect(refreshedIds).toEqual([SPECIALIST_B]);
  });

  it("T12: an idempotency-store throw on one specialist does not block the next", async () => {
    const list = makeListSpecialists([
      { specialistId: SPECIALIST_A, timezone: "America/New_York" },
      { specialistId: SPECIALIST_B, timezone: "America/New_York" },
    ]);
    const { store: realStore } = makeIdemStore();
    const acquireSpy = vi.spyOn(realStore, "acquire");
    let acquireCount = 0;
    acquireSpy.mockImplementation((input) => {
      acquireCount += 1;
      if (acquireCount === 1) {
        return Promise.reject(new Error("store boom"));
      }
      // Fall back to the real store behavior for subsequent calls.
      const HOUR = 60 * 60 * 1000;
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
      return Promise.resolve(row as IdempotencyRecord);
    });

    const result = await runNightlyCaseloadRefreshCron(
      baseOptions({
        now: () => NOW_TARGET_HOUR_ET,
        listSpecialists: list,
        idempotencyStore: realStore,
      }),
    );
    expect(result.specialistsFailed).toBe(1);
    expect(result.specialistsRefreshed).toBe(1);
  });
});

// ── T13: empty enumeration — no-op tick ────────────────────────────────────

describe("runNightlyCaseloadRefreshCron — empty enumeration", () => {
  it("T13: zero permission sets configured → no-op tick (FS-02 not-provisioned posture)", async () => {
    const list = makeListSpecialists([
      { specialistId: SPECIALIST_A, timezone: "America/New_York" },
    ]);
    const result = await runNightlyCaseloadRefreshCron(
      baseOptions({
        now: () => NOW_TARGET_HOUR_ET,
        listSpecialists: list,
        permissionSetNames: [], // empty — perm sets unprovisioned
      }),
    );
    expect(result.specialistsEnumerated).toBe(0);
    expect(result.specialistsConsidered).toBe(0);
    expect(result.specialistsRefreshed).toBe(0);
    expect(list).not.toHaveBeenCalled();
  });

  it("T14: SF enumeration returns empty → no-op tick (no perm-set assignees)", async () => {
    const list = makeListSpecialists([]);
    const result = await runNightlyCaseloadRefreshCron(
      baseOptions({
        now: () => NOW_TARGET_HOUR_ET,
        listSpecialists: list,
      }),
    );
    expect(result.specialistsEnumerated).toBe(0);
    expect(result.specialistsRefreshed).toBe(0);
  });
});

// ── T15: sequential dispatch — calls fire one-after-another ────────────────

describe("runNightlyCaseloadRefreshCron — sequential dispatch", () => {
  it("T15: the per-specialist refreshes fire sequentially (next does not start until prior completes)", async () => {
    const list = makeListSpecialists([
      { specialistId: SPECIALIST_A, timezone: "America/New_York" },
      { specialistId: SPECIALIST_B, timezone: "America/New_York" },
      { specialistId: SPECIALIST_C, timezone: "America/New_York" },
    ]);
    const inflight: string[] = [];
    const maxInflight: { value: number } = { value: 0 };
    const scoreSpy = vi.fn(async (specialistId: string) => {
      inflight.push(specialistId);
      maxInflight.value = Math.max(maxInflight.value, inflight.length);
      // Yield to the event loop so a non-sequential dispatcher would
      // overlap calls.
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
      inflight.pop();
      return {
        scored: [],
        roundTrips: 1,
        hydratedAt: NOW_TARGET_HOUR_ET,
        configuration: CONFIG,
        now: NOW_TARGET_HOUR_ET,
      } as ScoreCaseloadResult;
    }) as unknown as NonNullable<RefreshCaseloadHandlerOptions["scoreCaseloadImpl"]>;

    await runNightlyCaseloadRefreshCron(
      baseOptions({
        now: () => NOW_TARGET_HOUR_ET,
        listSpecialists: list,
        refreshOptions: { scoreCaseloadImpl: scoreSpy },
      }),
    );
    expect(maxInflight.value).toBe(1);
    expect(scoreSpy).toHaveBeenCalledTimes(3);
  });
});

// ── T16: result envelope — defines the cron route's wire shape ─────────────

describe("runNightlyCaseloadRefreshCron — result envelope", () => {
  it("T16: result counts tally with the outcomes array (route surfaces these in the JSON response)", async () => {
    const list = makeListSpecialists([
      { specialistId: SPECIALIST_A, timezone: "America/New_York" },
      { specialistId: SPECIALIST_B, timezone: "America/Los_Angeles" }, // off-hour at NYC target
      { specialistId: SPECIALIST_C, timezone: "America/New_York" },
    ]);
    const result = await runNightlyCaseloadRefreshCron(
      baseOptions({
        now: () => NOW_TARGET_HOUR_ET,
        listSpecialists: list,
      }),
    );
    expect(result.specialistsEnumerated).toBe(3);
    expect(result.specialistsConsidered).toBe(2);
    expect(result.specialistsRefreshed).toBe(2);
    expect(result.outcomes).toHaveLength(3);
    expect(result.tickStartedAt).toBe(NOW_TARGET_HOUR_ET.toISOString());
    expect(result.targetLocalHour).toBe(2);
  });
});

// ── T17: tests for the response body cached on COMPLETED ───────────────────

describe("runNightlyCaseloadRefreshCron — idempotency stored response", () => {
  it("T17: the COMPLETED idempotency row carries the refresh engine's response status + body", async () => {
    const list = makeListSpecialists([
      { specialistId: SPECIALIST_A, timezone: "America/New_York" },
    ]);
    const { store, rows } = makeIdemStore();
    await runNightlyCaseloadRefreshCron(
      baseOptions({
        now: () => NOW_TARGET_HOUR_ET,
        listSpecialists: list,
        idempotencyStore: store,
      }),
    );
    // Exactly one row written for the one refreshed specialist.
    expect(rows.size).toBe(1);
    const row = [...rows.values()][0]!;
    expect(row.status).toBe("COMPLETED");
    expect(row.responseStatusCode).toBe(200);
    expect(row.responseBody).toBeDefined();
    const body = row.responseBody as CaseloadBody;
    expect(body.specialistId).toBe(SPECIALIST_A);
  });
});
