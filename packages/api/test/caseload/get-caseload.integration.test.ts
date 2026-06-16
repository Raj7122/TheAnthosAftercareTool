import { randomUUID } from "node:crypto";

import { hashToken, loadSessionConfig, mintToken } from "@anthos/auth";
import { getCalibrationConfiguration } from "@anthos/domain";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { handleCaseload } from "../../src/caseload/get-caseload.js";
import type { CaseloadBody } from "../../src/caseload/dto.js";
import type { ScoreCaseloadResult } from "../../src/caseload/score-caseload.js";
import type { SessionRecord, SessionStore } from "../../src/session/store.js";
import { makeEngineOutput, makeScored, makeSnapshot } from "./_fixtures.js";

// Hits a real Postgres (Supabase/Neon) via DEMO_POSTGRES_URL. End-to-end proof
// for the P1C-01 cold path: `handleCaseload` runs the full
// hydrate → score → build → audit → cache-write-through pipeline against a
// real DB, a real `caseload_cache` repository, and the real `audit_log`
// writer. Salesforce is faked (`scoreCaseloadImpl`).
//
// A 200 here is itself the audit-emission proof: the `caseload.hydrated` row
// is awaited BEFORE the response (Pattern B / Immutable #5), so a failed
// `audit_log` INSERT would surface as a 500, never a 200.
//
// Scope note — this suite does NOT assert cache-row persistence across calls.
// P1C-02's `caseload-cache.integration.test.ts` `TRUNCATE`s `caseload_cache`
// in `beforeEach`; run in parallel against the shared demo DB it would wipe a
// row between this handler's write and a read-back. The warm/cold/stale cache
// branches are covered by the unit suite (`get-caseload.test.ts`, injected
// cache seam) and the cache repository itself by P1C-02's integration suite.
//
// Skipped when DEMO_POSTGRES_URL is unset so CI stays green (also exercises
// migration 0007 — `caseload_cache` must exist for the write-through to run).

const RUN = !!process.env.DEMO_POSTGRES_URL;

const SESSION_CONFIG = loadSessionConfig({});
const CONFIG = getCalibrationConfiguration();
const NOW = new Date("2026-05-15T12:00:00Z");

function makeStore(specialistId: string): { store: SessionStore; token: string } {
  const token = mintToken();
  const row: SessionRecord = {
    id: `session-${specialistId}`,
    specialistId,
    role: "SPECIALIST",
    lastActivityAt: new Date(),
    expiresAt: new Date(Date.now() + 11 * 60 * 60 * 1000),
    revoked: false,
    displayName: "Marie Alcis",
    email: "malcis@anthoshome.org",
    timezone: "America/New_York",
  };
  const rows = new Map<string, SessionRecord>([[hashToken(token), row]]);
  const store: SessionStore = {
    create: () => Promise.reject(new Error("create unused")),
    getByTokenHash: (h) => Promise.resolve(rows.get(h) ?? null),
    getSalesforceRefreshToken: () => Promise.resolve(null),
    touch: () => Promise.resolve(),
    applySessionRefresh: () => Promise.resolve(),
    revoke: () => Promise.resolve(),
    cleanupExpired: () => Promise.resolve(0),
  };
  return { store, token };
}

function caseloadReq(token: string, queue: string): Request {
  const url = new URL("https://bff.test/api/v1/caseload");
  url.searchParams.set("queue", queue);
  return new Request(url, {
    method: "GET",
    headers: { Cookie: `anthos_session=${token}` },
  });
}

function scoreResult(participantIds: ReadonlyArray<string>): ScoreCaseloadResult {
  return {
    scored: participantIds.map((id) =>
      makeScored(makeSnapshot(id, "owner"), makeEngineOutput(id)),
    ),
    roundTrips: 2,
    hydratedAt: NOW,
    configuration: CONFIG,
    now: NOW,
  };
}

describe.skipIf(!RUN)("handleCaseload — cold path (integration)", () => {
  // Lazy-imported so `@anthos/persistence` client.ts (throws on a missing
  // DEMO_POSTGRES_URL) never evaluates when the suite is skipped.
  let persistence: typeof import("@anthos/persistence");
  const usedSpecialistIds: string[] = [];

  beforeAll(async () => {
    persistence = await import("@anthos/persistence");
  });

  afterEach(async () => {
    // Cache is reconstructible derived state — evict this test's rows. Audit
    // rows are INSERT-only by design and harmlessly accumulate in the test DB.
    for (const specialistId of usedSpecialistIds) {
      await persistence.repositories.invalidateCaseloadCache(persistence.db, {
        kind: "specialist",
        specialistId,
      });
    }
    usedSpecialistIds.length = 0;
  });

  afterAll(async () => {
    await persistence.closeDb();
  });

  it("runs hydrate→score→build→audit→cache-write against a real DB and returns 200", async () => {
    const specialistId = randomUUID();
    usedSpecialistIds.push(specialistId);
    const { store, token } = makeStore(specialistId);

    // Real db / cache repository / audit writer (nothing DB-related injected);
    // only Salesforce is faked.
    const res = await handleCaseload(caseloadReq(token, "caseload_overview"), {
      store,
      sessionConfig: SESSION_CONFIG,
      configuration: CONFIG,
      scoreCaseloadImpl: () => Promise.resolve(scoreResult(["p-1", "p-2"])),
      now: () => NOW,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as CaseloadBody;
    expect(body.queue).toBe("caseload_overview");
    expect(body.items.map((item) => item.participantId).sort()).toEqual([
      "p-1",
      "p-2",
    ]);
    // Demo stub config is version 0 → floored to 1 for the `> 0` cache CHECK.
    expect(body.configurationVersion).toBe(1);
  });
});
