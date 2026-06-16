import { hashToken, loadSessionConfig, mintToken } from "@anthos/auth";
import type { Role } from "@anthos/auth";
import { getCalibrationConfiguration } from "@anthos/domain";
import type { EngineOutput } from "@anthos/domain";
import {
  SalesforceError,
  type SalesforceAuth,
  type SoqlQueryResponse,
} from "@anthos/integrations";
import type { DbOrTx } from "@anthos/persistence";
import { describe, expect, it, vi } from "vitest";

import { handleCloseBarrier } from "../../src/barriers/close-barrier.js";
import type { CloseBarrierHandlerOptions } from "../../src/barriers/close-barrier.js";
import type {
  IdempotencyRecord,
  IdempotencyStatus,
  IdempotencyStore,
} from "../../src/idempotency/store.js";
import type {
  ScoreCaseloadResult,
  ScoredParticipant,
} from "../../src/caseload/score-caseload.js";
import type { SessionRecord, SessionStore } from "../../src/session/store.js";
import { makeEngineOutput, makeScored } from "../caseload/_fixtures.js";
import { makeSnapshot } from "../calibration/_fixtures.js";

// ── fixtures ────────────────────────────────────────────────────────────────

const SESSION_CONFIG = loadSessionConfig({});
const HOUR = 60 * 60 * 1000;
const SPECIALIST_ID = "0058K00000XYZAbQAO";
const OTHER_SPECIALIST_ID = "0058K00000QQQXXxQAO";
const PARTICIPANT_ID = "a015g00000ABCDxQAO";
const BARRIER_ID = "a0K5g00000BARxAQAO";
const IDEM_KEY = "11111111-1111-4111-8111-111111111111";
const IDEM_KEY_B = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-05-23T15:30:00Z");
const NOW_DATE = "2026-05-23";
const CONFIG = getCalibrationConfiguration();
const FAKE_DB = {} as unknown as DbOrTx;

const PARTICIPANT_SCORED: ScoredParticipant = makeScored(
  makeSnapshot(PARTICIPANT_ID, SPECIALIST_ID),
  makeEngineOutput(PARTICIPANT_ID, { priorityScore: 64, tier: 2 }),
);

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

// Pre-read row shape: matches the SOQL select in runCloseBarrier.
type PreReadRow = {
  End_Date__c: string | null;
  Program_Enrollment__r: { Aftercare_Owner__c: string | null } | null;
};

// Mock M-SF rest client. The handler uses `query` for the combined VR-13 +
// authz pre-read and `updateRecord` for the End_Date__c PATCH. Tests that
// exercise SF errors override the relevant method.
function makeRestClient(opts: {
  ownerId?: string | null;
  endDate?: string | null;
  recordNotFound?: boolean;
  // SF sometimes returns the whole relationship object as null (e.g. when the
  // FK exists but the user's FLS hides the parent record entirely). Setting
  // `nullRelationship: true` exercises the handler's optional-chaining path
  // — distinct from `ownerId: null`, where the relationship object exists.
  nullRelationship?: boolean;
  queryError?: SalesforceError;
  updateError?: SalesforceError;
} = {}) {
  const queryFn = vi.fn(async (_soql: string) => {
    if (opts.queryError !== undefined) throw opts.queryError;
    if (opts.recordNotFound) {
      return {
        totalSize: 0,
        done: true,
        records: [],
      } as SoqlQueryResponse<PreReadRow>;
    }
    return {
      totalSize: 1,
      done: true,
      records: [
        {
          End_Date__c: opts.endDate ?? null,
          Program_Enrollment__r: opts.nullRelationship
            ? null
            : {
                // Distinguish "owner unset by caller" (defaults to specialist)
                // from "caller explicitly passed null" (data-orphan path).
                Aftercare_Owner__c:
                  opts.ownerId === undefined ? SPECIALIST_ID : opts.ownerId,
              },
        },
      ],
    } as SoqlQueryResponse<PreReadRow>;
  });
  const updateRecordFn = vi.fn(
    async (_sobject: string, _id: string, _fields: unknown) => {
      if (opts.updateError !== undefined) throw opts.updateError;
      return undefined;
    },
  );
  const client = {
    query: queryFn,
    updateRecord: updateRecordFn,
  } as unknown as import("@anthos/integrations").SalesforceRestClient;
  return { client, queryFn, updateRecordFn };
}

const FAKE_AUTH: SalesforceAuth = {
  getAccessToken: () => Promise.resolve("test-token"),
  getInstanceUrl: () => Promise.resolve("https://test.my.salesforce.com"),
};

function makeScoreCaseload(
  participantEngine: EngineOutput | null = makeEngineOutput(PARTICIPANT_ID, {
    priorityScore: 55,
    tier: 2,
  }),
): NonNullable<CloseBarrierHandlerOptions["scoreCaseloadImpl"]> {
  return vi.fn(
    () =>
      Promise.resolve({
        scored: [
          makeScored(makeSnapshot(PARTICIPANT_ID, SPECIALIST_ID), participantEngine),
        ],
        roundTrips: 2,
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
    specialistId: string;
    traceId?: string;
    participantId?: string;
    salesforceRecordId?: string;
    payloadMetadata?: Record<string, unknown>;
  }>;
  writer: NonNullable<CloseBarrierHandlerOptions["writeAudit"]>;
}

function makeAuditCapture(): AuditCapture {
  const audits: AuditCapture["audits"] = [];
  const writer: NonNullable<CloseBarrierHandlerOptions["writeAudit"]> = vi.fn(
    (_db, entry) => {
      audits.push({
        actionType: entry.actionType,
        outcome: entry.outcome,
        specialistId: entry.specialistId,
        ...(entry.traceId !== undefined ? { traceId: entry.traceId } : {}),
        ...(entry.participantId !== undefined
          ? { participantId: entry.participantId }
          : {}),
        ...(entry.salesforceRecordId !== undefined
          ? { salesforceRecordId: entry.salesforceRecordId }
          : {}),
        ...(entry.payloadMetadata !== undefined
          ? { payloadMetadata: entry.payloadMetadata as Record<string, unknown> }
          : {}),
      });
      return Promise.resolve({ id: `audit-${audits.length}` });
    },
  );
  return { audits, writer };
}

// `traceId` is optional: when provided the middleware echoes it on the response
// and propagates it to the audit row (P1E-05 trace_id assertion path).
function closeReq(
  token: string | undefined,
  body: unknown,
  idempotencyKey: string | null = IDEM_KEY,
  participantId: string = PARTICIPANT_ID,
  barrierId: string = BARRIER_ID,
  traceId?: string,
): Request {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (token !== undefined) headers.set("Cookie", `anthos_session=${token}`);
  if (idempotencyKey !== null) headers.set("Idempotency-Key", idempotencyKey);
  if (traceId !== undefined) headers.set("X-Trace-Id", traceId);
  return new Request(
    `https://bff.test/api/v1/participants/${participantId}/barriers/${barrierId}`,
    { method: "PATCH", headers, body: JSON.stringify(body) },
  );
}

function routeCtx(
  participantId: string = PARTICIPANT_ID,
  barrierId: string = BARRIER_ID,
) {
  return { params: Promise.resolve({ id: participantId, barrierId }) };
}

function baseOptions(
  store: SessionStore,
  overrides: Partial<CloseBarrierHandlerOptions> = {},
): CloseBarrierHandlerOptions {
  const audit = overrides.writeAudit ?? makeAuditCapture().writer;
  return {
    store,
    sessionConfig: SESSION_CONFIG,
    idempotencyStore: makeIdemStore(),
    db: FAKE_DB,
    writeAudit: audit,
    salesforceAuth: FAKE_AUTH,
    scoreCaseloadImpl: makeScoreCaseload(),
    now: () => NOW,
    ...overrides,
  };
}

// ── auth + idempotency gates ────────────────────────────────────────────────

describe("handleCloseBarrier — auth + idempotency gates", () => {
  it("401 AUTH_SESSION_INVALID when no session cookie is present", async () => {
    const { store } = makeStore();
    const { client } = makeRestClient();
    const res = await handleCloseBarrier(
      closeReq(undefined, { action: "close" }),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe(
      "AUTH_SESSION_INVALID",
    );
  });

  it("400 IDEMPOTENCY_KEY_REQUIRED when header is missing", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient();
    const res = await handleCloseBarrier(
      closeReq(token, { action: "close" }, null),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe(
      "IDEMPOTENCY_KEY_REQUIRED",
    );
  });
});

// ── request validation (discriminator, strict body, ID shapes) ───────────────

describe("handleCloseBarrier — request validation", () => {
  it("422 VALIDATION_FAILED when action is missing", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client, updateRecordFn } = makeRestClient();
    const res = await handleCloseBarrier(
      closeReq(token, {}),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      code: string;
      details?: { field?: string };
    };
    expect(body.code).toBe("VALIDATION_FAILED");
    expect(body.details?.field).toBe("action");
    expect(updateRecordFn).not.toHaveBeenCalled();
  });

  it("422 VALIDATION_FAILED when action is not 'close' (reopen not supported)", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient();
    const res = await handleCloseBarrier(
      closeReq(token, { action: "reopen" }),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { details?: { field?: string } };
    expect(body.details?.field).toBe("action");
  });

  it("422 VALIDATION_FAILED when closureReason exceeds 500 chars", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient();
    const res = await handleCloseBarrier(
      closeReq(token, { action: "close", closureReason: "x".repeat(501) }),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { details?: { field?: string } };
    expect(body.details?.field).toBe("closureReason");
  });

  it("strict-object: rejects unknown keys", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient();
    const res = await handleCloseBarrier(
      closeReq(token, { action: "close", unknownField: "x" }),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    expect(res.status).toBe(422);
  });

  it("422 VALIDATION_FAILED on invalid participant id shape", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient();
    const res = await handleCloseBarrier(
      closeReq(token, { action: "close" }, IDEM_KEY, "not-an-sf-id"),
      routeCtx("not-an-sf-id"),
      baseOptions(store, { restClient: client }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { details?: { field?: string } };
    expect(body.details?.field).toBe("participantId");
  });

  it("422 VALIDATION_FAILED on invalid barrier id shape", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient();
    const res = await handleCloseBarrier(
      closeReq(token, { action: "close" }, IDEM_KEY, PARTICIPANT_ID, "bad-id"),
      routeCtx(PARTICIPANT_ID, "bad-id"),
      baseOptions(store, { restClient: client }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { details?: { field?: string } };
    expect(body.details?.field).toBe("barrierId");
  });
});

// ── authz scope (BR-36, SEC-AUTHZ-3) ─────────────────────────────────────────

describe("handleCloseBarrier — authz scope", () => {
  it("SPECIALIST + own PE → 200", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient({ ownerId: SPECIALIST_ID });
    const res = await handleCloseBarrier(
      closeReq(token, { action: "close" }),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    expect(res.status).toBe(200);
  });

  it("SPECIALIST + someone else's PE → 403 NOT_IN_OWN_CASELOAD + no SF write", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client, updateRecordFn } = makeRestClient({
      ownerId: OTHER_SPECIALIST_ID,
    });
    const res = await handleCloseBarrier(
      closeReq(token, { action: "close" }),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe(
      "NOT_IN_OWN_CASELOAD",
    );
    expect(updateRecordFn).not.toHaveBeenCalled();
  });

  it("VP + any PE → 200 regardless of owner", async () => {
    const { store, seed } = makeStore();
    const token = seed("VP");
    const { client } = makeRestClient({ ownerId: OTHER_SPECIALIST_ID });
    const res = await handleCloseBarrier(
      closeReq(token, { action: "close" }),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    expect(res.status).toBe(200);
  });

  it("SUPERVISOR → 403 with details.reason=supervisor_scope_unmapped (stub)", async () => {
    const { store, seed } = makeStore();
    const token = seed("SUPERVISOR");
    const { client, updateRecordFn } = makeRestClient({
      ownerId: OTHER_SPECIALIST_ID,
    });
    const res = await handleCloseBarrier(
      closeReq(token, { action: "close" }),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as {
      code: string;
      details?: { reason?: string };
    };
    expect(body.code).toBe("ROLE_INSUFFICIENT_SCOPE");
    expect(body.details?.reason).toBe("supervisor_scope_unmapped");
    expect(updateRecordFn).not.toHaveBeenCalled();
  });

  it("SYSTEM_ADMIN → 403 with details.reason=role_not_permitted", async () => {
    const { store, seed } = makeStore();
    const token = seed("SYSTEM_ADMIN");
    const { client } = makeRestClient();
    const res = await handleCloseBarrier(
      closeReq(token, { action: "close" }),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as {
      code: string;
      details?: { reason?: string };
    };
    expect(body.code).toBe("ROLE_INSUFFICIENT_SCOPE");
    expect(body.details?.reason).toBe("role_not_permitted");
  });

  it("SPECIALIST + null Aftercare_Owner__c on the parent PE → 403 NOT_IN_OWN_CASELOAD (data-orphan path)", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client, updateRecordFn } = makeRestClient({ ownerId: null });
    const res = await handleCloseBarrier(
      closeReq(token, { action: "close" }),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe(
      "NOT_IN_OWN_CASELOAD",
    );
    expect(updateRecordFn).not.toHaveBeenCalled();
  });

  it("VP + null Aftercare_Owner__c → 200 with degraded priorityRecomputed (recompute requires an ownerId)", async () => {
    const { store, seed } = makeStore();
    const token = seed("VP");
    const { client, updateRecordFn } = makeRestClient({ ownerId: null });
    const score = makeScoreCaseload();
    const res = await handleCloseBarrier(
      closeReq(token, { action: "close" }),
      routeCtx(),
      baseOptions(store, { restClient: client, scoreCaseloadImpl: score }),
    );
    expect(res.status).toBe(200);
    // The close lands in SF — but the recompute is skipped because there is
    // no ownerId to scope `scoreCaseload` against. The response stays shape-
    // correct with a null priorityRecomputed.
    expect(updateRecordFn).toHaveBeenCalledTimes(1);
    expect(score).not.toHaveBeenCalled();
    const body = (await res.json()) as {
      priorityRecomputed: { score: number | null; tier: number | null };
    };
    expect(body.priorityRecomputed.score).toBeNull();
    expect(body.priorityRecomputed.tier).toBeNull();
  });

  it("SPECIALIST + null Program_Enrollment__r relationship object → 403 (optional-chaining yields null ownerId)", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client, updateRecordFn } = makeRestClient({
      nullRelationship: true,
    });
    const res = await handleCloseBarrier(
      closeReq(token, { action: "close" }),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe(
      "NOT_IN_OWN_CASELOAD",
    );
    expect(updateRecordFn).not.toHaveBeenCalled();
  });

  it("404 RESOURCE_NOT_FOUND when the Barrier is not under the URL's PE", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client, updateRecordFn } = makeRestClient({ recordNotFound: true });
    const res = await handleCloseBarrier(
      closeReq(token, { action: "close" }),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    expect(res.status).toBe(404);
    expect(updateRecordFn).not.toHaveBeenCalled();
  });
});

// ── VR-13 already-closed (EC-20 — both racing attempts MUST audit) ──────────

describe("handleCloseBarrier — VR-13 already-closed", () => {
  it("returns 422 VALIDATION_FAILED + emits a FAILED audit row (EC-20)", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client, updateRecordFn } = makeRestClient({
      endDate: "2026-05-22", // already populated
    });
    const capture = makeAuditCapture();
    const res = await handleCloseBarrier(
      closeReq(token, { action: "close" }),
      routeCtx(),
      baseOptions(store, { restClient: client, writeAudit: capture.writer }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      code: string;
      details?: { field?: string; reason?: string };
    };
    expect(body.code).toBe("VALIDATION_FAILED");
    expect(body.details?.field).toBe("barrier");
    expect(body.details?.reason).toBe("already_closed");

    // No SF PATCH issued — the pre-read short-circuited.
    expect(updateRecordFn).not.toHaveBeenCalled();

    // Audit row written BEFORE the response per ticket §Notes EC-20: both
    // racing close attempts MUST audit, even when VR-13 catches the loser.
    expect(capture.audits).toHaveLength(1);
    expect(capture.audits[0]).toMatchObject({
      actionType: "barrier.closed",
      outcome: "FAILED",
      participantId: PARTICIPANT_ID,
      salesforceRecordId: BARRIER_ID,
    });
    expect(capture.audits[0]?.payloadMetadata).toMatchObject({
      source: "tool",
      failure_phase: "already_closed",
    });
  });

  it("VR-13 + idempotency replay returns the cached 422 and re-emits no audit", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient({ endDate: "2026-05-22" });
    const capture = makeAuditCapture();
    const opts = baseOptions(store, {
      restClient: client,
      writeAudit: capture.writer,
      idempotencyStore: makeIdemStore(),
    });
    const res1 = await handleCloseBarrier(
      closeReq(token, { action: "close" }),
      routeCtx(),
      opts,
    );
    const res2 = await handleCloseBarrier(
      closeReq(token, { action: "close" }),
      routeCtx(),
      opts,
    );
    expect(res1.status).toBe(422);
    expect(res2.status).toBe(422);
    // Audit fires exactly once — the replay returns the cached body without
    // re-running the handler.
    expect(capture.audits).toHaveLength(1);
    expect(res2.headers.get("X-Idempotent-Replay")).toBe("true");
  });
});

// ── happy path: SF PATCH, response shape, audit ─────────────────────────────

describe("handleCloseBarrier — happy path", () => {
  it("PATCHes Barriers__c with End_Date__c=today", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client, updateRecordFn } = makeRestClient();
    await handleCloseBarrier(
      closeReq(token, { action: "close" }),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    expect(updateRecordFn).toHaveBeenCalledTimes(1);
    const [sobject, recordId, fields] = updateRecordFn.mock.calls[0]!;
    expect(sobject).toBe("Barriers__c");
    expect(recordId).toBe(BARRIER_ID);
    expect(fields).toEqual({ End_Date__c: NOW_DATE });
    // Status__c is a SF formula — CLOSED-03 — and must NOT be written.
    expect(fields).not.toHaveProperty("Status__c");
  });

  it("response matches E-16 shape with priorityRecomputed block", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient();
    const res = await handleCloseBarrier(
      closeReq(token, {
        action: "close",
        closureReason: "Reached participant; phone reconnected",
      }),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      barrierId: BARRIER_ID,
      participantId: PARTICIPANT_ID,
      status: "closed",
      closedAt: NOW.toISOString(),
      closedBy: SPECIALIST_ID,
      closureReason: "Reached participant; phone reconnected",
    });
    expect(body.priorityRecomputed).toMatchObject({
      participantId: PARTICIPANT_ID,
      score: 55,
      tier: 2,
      previousScore: null,
      previousTier: null,
    });
  });

  it("closureReason absent → echoes null in response", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient();
    const res = await handleCloseBarrier(
      closeReq(token, { action: "close" }),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    const body = (await res.json()) as { closureReason: string | null };
    expect(body.closureReason).toBeNull();
  });

  it("emits a barrier.closed SUCCESS audit row with structural metadata only", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient();
    const capture = makeAuditCapture();
    // Inbound trace id — the audit row must carry the same value the
    // middleware echoes on X-Trace-Id (ERD §8.2 cross-table correlation).
    const inboundTrace = "bbbbbbbb-cccc-4ddd-8eee-222222222222";
    const res = await handleCloseBarrier(
      closeReq(
        token,
        { action: "close", closureReason: "free-text reason" },
        IDEM_KEY,
        PARTICIPANT_ID,
        BARRIER_ID,
        inboundTrace,
      ),
      routeCtx(),
      baseOptions(store, { restClient: client, writeAudit: capture.writer }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Trace-Id")).toBe(inboundTrace);
    expect(capture.audits).toHaveLength(1);
    // SEC-AUDIT-1a required columns: specialistId (session-resolved), action,
    // outcome, participantId, salesforceRecordId (dedicated columns — Barrier
    // ID + Program Enrollment ID live here, NOT in payload_metadata), traceId.
    expect(capture.audits[0]).toMatchObject({
      actionType: "barrier.closed",
      outcome: "SUCCESS",
      specialistId: SPECIALIST_ID,
      participantId: PARTICIPANT_ID,
      salesforceRecordId: BARRIER_ID,
      traceId: inboundTrace,
    });
    // PII firewall: the closureReason text is NEVER in payload_metadata —
    // only the boolean structural fact lands there.
    const metadata = capture.audits[0]!.payloadMetadata!;
    expect(metadata).toEqual({
      source: "tool",
      closure_reason_provided: true,
    });
    expect(JSON.stringify(metadata)).not.toContain("free-text reason");
  });

  it("audit closure_reason_provided is false when reason is omitted", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient();
    const capture = makeAuditCapture();
    await handleCloseBarrier(
      closeReq(token, { action: "close" }),
      routeCtx(),
      baseOptions(store, { restClient: client, writeAudit: capture.writer }),
    );
    expect(capture.audits[0]?.payloadMetadata).toMatchObject({
      closure_reason_provided: false,
    });
  });
});

// ── Salesforce failure mapping ──────────────────────────────────────────────

describe("handleCloseBarrier — Salesforce failures", () => {
  it("SF_VALIDATION_FAILED on PATCH → 422 + FAILED audit (failure_phase=close)", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient({
      updateError: new SalesforceError(
        "SF_VALIDATION_FAILED",
        "FIELD_CUSTOM_VALIDATION_EXCEPTION",
        400,
      ),
    });
    const capture = makeAuditCapture();
    const res = await handleCloseBarrier(
      closeReq(token, { action: "close" }),
      routeCtx(),
      baseOptions(store, { restClient: client, writeAudit: capture.writer }),
    );
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe(
      "VALIDATION_FAILED",
    );
    expect(capture.audits[0]).toMatchObject({
      actionType: "barrier.closed",
      outcome: "FAILED",
      salesforceRecordId: BARRIER_ID,
    });
    expect(capture.audits[0]?.payloadMetadata).toMatchObject({
      failure_phase: "close",
      sf_code: "SF_VALIDATION_FAILED",
    });
  });

  it("SF outage during pre-read → 503 + FAILED audit (failure_phase=authz_lookup)", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client, updateRecordFn } = makeRestClient({
      queryError: new SalesforceError(
        "SF_NETWORK_TIMEOUT",
        "Salesforce request timed out after 10000ms",
      ),
    });
    const capture = makeAuditCapture();
    const res = await handleCloseBarrier(
      closeReq(token, { action: "close" }),
      routeCtx(),
      baseOptions(store, { restClient: client, writeAudit: capture.writer }),
    );
    expect(res.status).toBe(503);
    expect(capture.audits).toHaveLength(1);
    expect(capture.audits[0]).toMatchObject({
      actionType: "barrier.closed",
      outcome: "FAILED",
      participantId: PARTICIPANT_ID,
      salesforceRecordId: BARRIER_ID,
    });
    expect(capture.audits[0]?.payloadMetadata).toMatchObject({
      source: "tool",
      sf_code: "SF_NETWORK_TIMEOUT",
      failure_phase: "authz_lookup",
    });
    expect(updateRecordFn).not.toHaveBeenCalled();
  });

  it("SF_FIELD_FLS_DENIED on PATCH → 403", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient({
      updateError: new SalesforceError("SF_FIELD_FLS_DENIED", "denied", 403),
    });
    const res = await handleCloseBarrier(
      closeReq(token, { action: "close" }),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    expect(res.status).toBe(403);
  });

  it("SF_NETWORK_TIMEOUT on PATCH → 503 SF_UPSTREAM_UNAVAILABLE", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient({
      updateError: new SalesforceError(
        "SF_NETWORK_TIMEOUT",
        "Salesforce request timed out after 10000ms",
      ),
    });
    const res = await handleCloseBarrier(
      closeReq(token, { action: "close" }),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    expect(res.status).toBe(503);
  });
});

// ── priorityRecomputed best-effort ──────────────────────────────────────────

describe("handleCloseBarrier — priorityRecomputed degradation", () => {
  it("returns degraded shape when the scoring kernel throws (close still 200)", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient();
    const failingScore: NonNullable<
      CloseBarrierHandlerOptions["scoreCaseloadImpl"]
    > = vi.fn(() => Promise.reject(new Error("transient")));
    const res = await handleCloseBarrier(
      closeReq(token, { action: "close" }),
      routeCtx(),
      baseOptions(store, {
        restClient: client,
        scoreCaseloadImpl: failingScore,
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      priorityRecomputed: {
        participantId: string;
        score: number | null;
        tier: number | null;
      };
    };
    expect(body.priorityRecomputed).toEqual({
      participantId: PARTICIPANT_ID,
      score: null,
      tier: null,
      factors: [],
      previousScore: null,
      previousTier: null,
    });
  });

  it("returns degraded shape when the kernel cannot score (engine === null)", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient();
    const res = await handleCloseBarrier(
      closeReq(token, { action: "close" }),
      routeCtx(),
      baseOptions(store, {
        restClient: client,
        scoreCaseloadImpl: makeScoreCaseload(null),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      priorityRecomputed: { score: number | null };
    };
    expect(body.priorityRecomputed.score).toBeNull();
  });
});

// ── idempotency replay (Pattern D) ──────────────────────────────────────────

describe("handleCloseBarrier — idempotency", () => {
  it("replay with the same key returns the cached response without re-running the handler", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client, updateRecordFn, queryFn } = makeRestClient();
    const idemStore = makeIdemStore();
    const opts = baseOptions(store, {
      restClient: client,
      idempotencyStore: idemStore,
    });
    const res1 = await handleCloseBarrier(
      closeReq(token, { action: "close" }, IDEM_KEY),
      routeCtx(),
      opts,
    );
    const res2 = await handleCloseBarrier(
      closeReq(token, { action: "close" }, IDEM_KEY),
      routeCtx(),
      opts,
    );
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    // SF round-trips fire exactly once for the original request.
    expect(updateRecordFn).toHaveBeenCalledTimes(1);
    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(res2.headers.get("X-Idempotent-Replay")).toBe("true");
  });

  it("different key → handler runs again (no idempotent replay)", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    // Two distinct Barriers under the same PE — second key targets a different
    // barrier id so VR-13 stays clear of the second close.
    const { client, updateRecordFn } = makeRestClient();
    const idemStore = makeIdemStore();
    const opts = baseOptions(store, {
      restClient: client,
      idempotencyStore: idemStore,
    });
    await handleCloseBarrier(
      closeReq(token, { action: "close" }, IDEM_KEY),
      routeCtx(),
      opts,
    );
    await handleCloseBarrier(
      closeReq(token, { action: "close" }, IDEM_KEY_B),
      routeCtx(),
      opts,
    );
    expect(updateRecordFn).toHaveBeenCalledTimes(2);
  });
});

// ── write-ordering invariant (Pattern B / Immutable #5) ────────────────────

describe("handleCloseBarrier — audit gates response (Pattern B / Immutable #5)", () => {
  it("response is 500 INTERNAL_ERROR when the SUCCESS audit write throws (audit row gates the response)", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client, updateRecordFn } = makeRestClient();
    // The handler awaits writeAudit BEFORE constructing the 200 response. If
    // the audit write throws, the handler's outer catch turns it into 500 —
    // proves the response is gated on audit settlement. A passing 200 here
    // would mean we shipped a barrier closure without a durable audit row.
    const failingWriter: NonNullable<CloseBarrierHandlerOptions["writeAudit"]> =
      vi.fn(() => Promise.reject(new Error("audit-write-failed")));
    const res = await handleCloseBarrier(
      closeReq(token, { action: "close" }),
      routeCtx(),
      baseOptions(store, { restClient: client, writeAudit: failingWriter }),
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("INTERNAL_ERROR");
    // Belt-and-braces: a future fire-and-forget refactor (`void writeAudit(...)`)
    // could still ship the 200 success body even when audit rejects. Pinning
    // the absence of `barrierId` makes that regression loudly fail.
    expect(body.barrierId).toBeUndefined();
    // SF PATCH happened before the audit emission (success path) — the 500
    // therefore proves the response stage was gated on audit, not on SF.
    expect(updateRecordFn).toHaveBeenCalledTimes(1);
    expect(failingWriter).toHaveBeenCalledTimes(1);
  });
});

// ── Pattern B PII firewall integration (real writeAuditEntry) ──────────────

describe("handleCloseBarrier — Pattern B PII firewall (real writer)", () => {
  it("the real assertNoPii in writeAuditEntry does not throw on our barrier.closed metadata shape", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient();
    // Use the real writer (it reaches the DB via Drizzle.insert which we stub).
    const { writeAuditEntry } = await import("@anthos/audit");
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

    const res = await handleCloseBarrier(
      closeReq(token, { action: "close", closureReason: "free-text reason" }),
      routeCtx(),
      baseOptions(store, {
        restClient: client,
        db: fakeDb,
        writeAudit: writeAuditEntry,
      }),
    );
    expect(res.status).toBe(200);
    expect(insertedRows).toHaveLength(1);
    // Belt-and-braces: the inserted row also carries no closureReason text. A
    // bypass of assertNoPii that admitted the closureReason to payload_metadata
    // would surface here even if the schema validator silently let it through.
    expect(JSON.stringify(insertedRows[0])).not.toContain("free-text reason");
  });
});

// Use of NOW_DATE keeps lint quiet about an unused fixture across describe
// blocks — End_Date__c derives from `now()` in the happy-path suite.
void NOW_DATE;
void PARTICIPANT_SCORED;
