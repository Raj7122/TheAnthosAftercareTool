import { hashToken, loadSessionConfig, mintToken } from "@anthos/auth";
import type { Role } from "@anthos/auth";
import { getCalibrationConfiguration } from "@anthos/domain";
import type { EngineOutput } from "@anthos/domain";
import {
  SalesforceError,
  type SalesforceAuth,
  type SoqlQueryResponse,
  type CreateRecordResult,
} from "@anthos/integrations";
import type { DbOrTx } from "@anthos/persistence";
import { describe, expect, it, vi } from "vitest";

import { handleCreateBarrier } from "../../src/barriers/create-barrier.js";
import type { CreateBarrierHandlerOptions } from "../../src/barriers/create-barrier.js";
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
// SF User Id (`005...`) — what `parseSalesforceUserId` lands on the session
// row at /auth/callback. Matched against PE.Aftercare_Owner__c in authz.
const SPECIALIST_ID = "0058K00000XYZAbQAO";
const OTHER_SPECIALIST_ID = "0058K00000QQQXXxQAO";
const PARTICIPANT_ID = "a015g00000ABCDxQAO";
const IDEM_KEY = "11111111-1111-4111-8111-111111111111";
const IDEM_KEY_B = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-05-22T15:30:00Z");
const NOW_DATE = "2026-05-22";
const CONFIG = getCalibrationConfiguration();
// A non-DB sentinel — every audit/SF seam is faked, so `db` is never read.
const FAKE_DB = {} as unknown as DbOrTx;

const PARTICIPANT_SCORED: ScoredParticipant = makeScored(
  makeSnapshot(PARTICIPANT_ID, SPECIALIST_ID),
  makeEngineOutput(PARTICIPANT_ID, { priorityScore: 72, tier: 1 }),
);

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

// Mock M-SF rest client. The handler uses `query` for PE-owner lookup and
// `createRecord` for the Barrier write. Any test that exercises a downstream
// SF error overrides the relevant method.
function makeRestClient(opts: {
  ownerId?: string | null;
  recordNotFound?: boolean;
  createResult?: CreateRecordResult;
  createError?: SalesforceError;
  queryError?: SalesforceError;
} = {}) {
  const queryFn = vi.fn(async (_soql: string) => {
    if (opts.queryError !== undefined) throw opts.queryError;
    if (opts.recordNotFound) {
      return { totalSize: 0, done: true, records: [] } as SoqlQueryResponse<{
        Aftercare_Owner__c: string | null;
      }>;
    }
    return {
      totalSize: 1,
      done: true,
      records: [{ Aftercare_Owner__c: opts.ownerId ?? SPECIALIST_ID }],
    } as SoqlQueryResponse<{ Aftercare_Owner__c: string | null }>;
  });
  const createRecordFn = vi.fn(async (_sobject: string, _fields: unknown) => {
    if (opts.createError !== undefined) throw opts.createError;
    return (
      opts.createResult ?? {
        id: "a0K5g00000NEWxQAO",
        success: true,
        errors: [],
      }
    );
  });
  // Cast to the shape the handler imports; only `query` and `createRecord` are
  // exercised.
  const client = {
    query: queryFn,
    createRecord: createRecordFn,
  } as unknown as ConstructorParameters<typeof Object>[0];
  return {
    client: client as unknown as import("@anthos/integrations").SalesforceRestClient,
    queryFn,
    createRecordFn,
  };
}

// SalesforceAuth stub — never reached when restClient is injected, but
// withIdempotency clones the auth instance the handler instantiates. We always
// pass an injected `restClient`, so this is purely belt-and-braces.
const FAKE_AUTH: SalesforceAuth = {
  getAccessToken: () => Promise.resolve("test-token"),
  getInstanceUrl: () => Promise.resolve("https://test.my.salesforce.com"),
};

function makeScoreCaseload(
  participantEngine: EngineOutput | null = makeEngineOutput(PARTICIPANT_ID, {
    priorityScore: 81,
    tier: 1,
  }),
): NonNullable<CreateBarrierHandlerOptions["scoreCaseloadImpl"]> {
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
  writer: NonNullable<CreateBarrierHandlerOptions["writeAudit"]>;
}

function makeAuditCapture(): AuditCapture {
  const audits: AuditCapture["audits"] = [];
  const writer: NonNullable<CreateBarrierHandlerOptions["writeAudit"]> = vi.fn(
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

// Pass `null` for `idempotencyKey` to omit the header; omitting the argument
// keeps the IDEM_KEY default — JS default params kick in for `undefined`, so
// callers asserting on the absent-header path MUST pass `null` explicitly.
// `traceId` is optional: when provided the middleware echoes it on the response
// and propagates it to the audit row (P1E-05 trace_id assertion path).
function barrierReq(
  token: string | undefined,
  body: unknown,
  idempotencyKey: string | null = IDEM_KEY,
  participantId: string = PARTICIPANT_ID,
  traceId?: string,
): Request {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (token !== undefined) headers.set("Cookie", `anthos_session=${token}`);
  if (idempotencyKey !== null) headers.set("Idempotency-Key", idempotencyKey);
  if (traceId !== undefined) headers.set("X-Trace-Id", traceId);
  return new Request(
    `https://bff.test/api/v1/participants/${participantId}/barriers`,
    { method: "POST", headers, body: JSON.stringify(body) },
  );
}

function routeCtx(participantId: string = PARTICIPANT_ID) {
  return { params: Promise.resolve({ id: participantId }) };
}

function baseOptions(
  store: SessionStore,
  overrides: Partial<CreateBarrierHandlerOptions> = {},
): CreateBarrierHandlerOptions {
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

describe("handleCreateBarrier — auth + idempotency gates", () => {
  it("401 AUTH_SESSION_INVALID when no session cookie is present", async () => {
    const { store } = makeStore();
    const { client } = makeRestClient();
    const res = await handleCreateBarrier(
      barrierReq(undefined, { type: "PA issue" }),
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
    const res = await handleCreateBarrier(
      barrierReq(token, { type: "PA issue" }, null),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe(
      "IDEMPOTENCY_KEY_REQUIRED",
    );
  });
});

// ── request validation (VR-12, VR-14, strict body) ──────────────────────────

describe("handleCreateBarrier — request validation", () => {
  it("VR-14: 422 VALIDATION_FAILED on missing type", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient();
    const res = await handleCreateBarrier(
      barrierReq(token, {}),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      code: string;
      details?: { field?: string };
    };
    expect(body.code).toBe("VALIDATION_FAILED");
    expect(body.details?.field).toBe("type");
  });

  it("VR-12: 422 VALIDATION_FAILED on unknown Type", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient();
    const res = await handleCreateBarrier(
      barrierReq(token, { type: "not in the picklist" }),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      code: string;
      details?: { field?: string; reason?: string };
    };
    expect(body.code).toBe("VALIDATION_FAILED");
    expect(body.details?.field).toBe("type");
    expect(body.details?.reason).toBe("unknown_barrier_type");
  });

  it("strict-object: rejects `openDate` (server-set per ticket scope)", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient();
    const res = await handleCreateBarrier(
      barrierReq(token, { type: "PA issue", openDate: "2026-01-01" }),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    expect(res.status).toBe(422);
  });

  it("422 VALIDATION_FAILED on invalid participant id shape", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient();
    const res = await handleCreateBarrier(
      barrierReq(token, { type: "PA issue" }, IDEM_KEY, "not-an-sf-id"),
      routeCtx("not-an-sf-id"),
      baseOptions(store, { restClient: client }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { details?: { field?: string } };
    expect(body.details?.field).toBe("participantId");
  });
});

// ── authz scope (BR-35, SEC-AUTHZ-3) ─────────────────────────────────────────

describe("handleCreateBarrier — authz scope", () => {
  it("SPECIALIST + own PE → 201", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient({ ownerId: SPECIALIST_ID });
    const res = await handleCreateBarrier(
      barrierReq(token, { type: "PA issue" }),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    expect(res.status).toBe(201);
  });

  it("SPECIALIST + someone else's PE → 403 NOT_IN_OWN_CASELOAD", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client, createRecordFn } = makeRestClient({
      ownerId: OTHER_SPECIALIST_ID,
    });
    const res = await handleCreateBarrier(
      barrierReq(token, { type: "PA issue" }),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe(
      "NOT_IN_OWN_CASELOAD",
    );
    // No SF write on a denied scope.
    expect(createRecordFn).not.toHaveBeenCalled();
  });

  it("VP + any PE → 201 regardless of owner", async () => {
    const { store, seed } = makeStore();
    const token = seed("VP");
    const { client } = makeRestClient({ ownerId: OTHER_SPECIALIST_ID });
    const res = await handleCreateBarrier(
      barrierReq(token, { type: "PA issue" }),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    expect(res.status).toBe(201);
  });

  it("SUPERVISOR → 403 ROLE_INSUFFICIENT_SCOPE with details.reason=supervisor_scope_unmapped (stub, pending supervisor→supervised mapping)", async () => {
    const { store, seed } = makeStore();
    const token = seed("SUPERVISOR");
    const { client, createRecordFn } = makeRestClient({
      ownerId: OTHER_SPECIALIST_ID,
    });
    const res = await handleCreateBarrier(
      barrierReq(token, { type: "PA issue" }),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as {
      code: string;
      details?: { reason?: string };
    };
    expect(body.code).toBe("ROLE_INSUFFICIENT_SCOPE");
    // The SPA distinguishes the temporary-stub case so it can tell the user
    // "your role will be permitted soon" rather than "permanently denied".
    expect(body.details?.reason).toBe("supervisor_scope_unmapped");
    expect(createRecordFn).not.toHaveBeenCalled();
  });

  it("SYSTEM_ADMIN → 403 ROLE_INSUFFICIENT_SCOPE with details.reason=role_not_permitted (permanent exclusion)", async () => {
    const { store, seed } = makeStore();
    const token = seed("SYSTEM_ADMIN");
    const { client } = makeRestClient();
    const res = await handleCreateBarrier(
      barrierReq(token, { type: "PA issue" }),
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

  it("404 RESOURCE_NOT_FOUND when the PE is unknown", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client, createRecordFn } = makeRestClient({ recordNotFound: true });
    const res = await handleCreateBarrier(
      barrierReq(token, { type: "PA issue" }),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    expect(res.status).toBe(404);
    expect(createRecordFn).not.toHaveBeenCalled();
  });
});

// ── happy path: server-set fields, response shape, audit ────────────────────

describe("handleCreateBarrier — happy path", () => {
  it("writes Stage='Aftercare' and Start_Date=today to Salesforce", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client, createRecordFn } = makeRestClient();
    await handleCreateBarrier(
      barrierReq(token, { type: "PA issue", description: "phone disconnected" }),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    expect(createRecordFn).toHaveBeenCalledTimes(1);
    const [sobject, payload] = createRecordFn.mock.calls[0]!;
    expect(sobject).toBe("Barriers__c");
    expect(payload).toMatchObject({
      Type__c: "PA issue",
      Stage__c: "Aftercare",
      Start_Date__c: NOW_DATE,
      Program_Enrollment__c: PARTICIPANT_ID,
      Description__c: "phone disconnected",
    });
  });

  it("omits Description__c when description is absent", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client, createRecordFn } = makeRestClient();
    await handleCreateBarrier(
      barrierReq(token, { type: "PA issue" }),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    const [, payload] = createRecordFn.mock.calls[0]!;
    expect(payload).not.toHaveProperty("Description__c");
  });

  it("response matches E-15 shape with classified severity", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient({
      createResult: { id: "a0K5g00000BARxQAO", success: true, errors: [] },
    });
    const res = await handleCreateBarrier(
      barrierReq(token, { type: "Domestic Violence" }),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      barrierId: "a0K5g00000BARxQAO",
      participantId: PARTICIPANT_ID,
      type: "Domestic Violence",
      severity: "high", // BR-37 classification (no client override)
      status: "open",
      openedBy: SPECIALIST_ID,
      openedAt: NOW.toISOString(),
    });
    expect(body.priorityRecomputed).toMatchObject({
      participantId: PARTICIPANT_ID,
      score: 81,
      tier: 1,
      previousScore: null,
      previousTier: null,
    });
  });

  it("client severity override wins over classification", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient();
    const res = await handleCreateBarrier(
      barrierReq(token, { type: "PA issue", severity: "high" }),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    const body = (await res.json()) as { severity: string };
    expect(body.severity).toBe("high"); // not the "low" classification
  });

  it("writes a barrier.created SUCCESS audit row before the response", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient();
    const capture = makeAuditCapture();
    // Inbound trace id — the audit row must carry the same value the
    // middleware echoes on X-Trace-Id (ERD §8.2 cross-table correlation).
    const inboundTrace = "aaaaaaaa-bbbb-4ccc-8ddd-111111111111";
    const res = await handleCreateBarrier(
      barrierReq(token, { type: "PA issue" }, IDEM_KEY, PARTICIPANT_ID, inboundTrace),
      routeCtx(),
      baseOptions(store, { restClient: client, writeAudit: capture.writer }),
    );
    expect(res.status).toBe(201);
    expect(res.headers.get("X-Trace-Id")).toBe(inboundTrace);
    expect(capture.audits).toHaveLength(1);
    // SEC-AUDIT-1a required columns: specialistId (session-resolved), action,
    // outcome, participantId, salesforceRecordId (dedicated columns — Barrier
    // ID + Program Enrollment ID live here, NOT in payload_metadata), traceId.
    expect(capture.audits[0]).toMatchObject({
      actionType: "barrier.created",
      outcome: "SUCCESS",
      specialistId: SPECIALIST_ID,
      participantId: PARTICIPANT_ID,
      salesforceRecordId: "a0K5g00000NEWxQAO",
      traceId: inboundTrace,
    });
    // Payload metadata carries structural facts only — no description, no PII.
    const metadata = capture.audits[0]!.payloadMetadata!;
    expect(metadata).toEqual({
      barrier_type: "PA issue",
      severity_tier: "low",
      source: "tool",
    });
  });

  it("PII firewall: free-text description never lands in payload_metadata", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient();
    const capture = makeAuditCapture();
    // The description field is free-text — effectively PII-adjacent. The
    // functional response carries it; the audit row MUST NOT (SEC-AUDIT-4 +
    // API §11.6 — payload_metadata excludes "message content … any payload
    // representation"). Mirrors the close-barrier closureReason firewall.
    const phiText = "free-text barrier description with sensitive detail";
    const res = await handleCreateBarrier(
      barrierReq(token, { type: "PA issue", description: phiText }),
      routeCtx(),
      baseOptions(store, { restClient: client, writeAudit: capture.writer }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { description: string };
    expect(body.description).toBe(phiText);
    expect(capture.audits).toHaveLength(1);
    const metadata = capture.audits[0]!.payloadMetadata!;
    expect(JSON.stringify(metadata)).not.toContain("sensitive detail");
  });
});

// ── Salesforce failure mapping ──────────────────────────────────────────────

describe("handleCreateBarrier — Salesforce failures", () => {
  it("SF_VALIDATION_FAILED on createRecord → 422 + FAILED audit", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient({
      createError: new SalesforceError(
        "SF_VALIDATION_FAILED",
        "STRING_TOO_LONG",
        400,
      ),
    });
    const capture = makeAuditCapture();
    const res = await handleCreateBarrier(
      barrierReq(token, { type: "PA issue" }),
      routeCtx(),
      baseOptions(store, { restClient: client, writeAudit: capture.writer }),
    );
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe(
      "VALIDATION_FAILED",
    );
    expect(capture.audits[0]).toMatchObject({
      actionType: "barrier.created",
      outcome: "FAILED",
    });
    expect(capture.audits[0]?.salesforceRecordId).toBeUndefined();
    expect(capture.audits[0]?.payloadMetadata).toMatchObject({
      failure_phase: "create",
      sf_code: "SF_VALIDATION_FAILED",
    });
  });

  it("SF outage during authz-lookup → 503 + FAILED audit (failure_phase=authz_lookup)", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client, createRecordFn } = makeRestClient({
      queryError: new SalesforceError(
        "SF_NETWORK_TIMEOUT",
        "Salesforce request timed out after 10000ms",
      ),
    });
    const capture = makeAuditCapture();
    const res = await handleCreateBarrier(
      barrierReq(token, { type: "PA issue" }),
      routeCtx(),
      baseOptions(store, { restClient: client, writeAudit: capture.writer }),
    );
    expect(res.status).toBe(503);
    // Audit row written BEFORE the response on this pre-mutation upstream
    // failure — request was valid + role-gateable, so it audits per Pattern B.
    expect(capture.audits).toHaveLength(1);
    expect(capture.audits[0]).toMatchObject({
      actionType: "barrier.created",
      outcome: "FAILED",
      participantId: PARTICIPANT_ID,
    });
    expect(capture.audits[0]?.salesforceRecordId).toBeUndefined();
    expect(capture.audits[0]?.payloadMetadata).toMatchObject({
      barrier_type: "PA issue",
      source: "tool",
      sf_code: "SF_NETWORK_TIMEOUT",
      failure_phase: "authz_lookup",
    });
    // The SF authz-lookup failed BEFORE the create attempt — no DML round-trip.
    expect(createRecordFn).not.toHaveBeenCalled();
  });

  it("SF_FIELD_FLS_DENIED → 403", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient({
      createError: new SalesforceError("SF_FIELD_FLS_DENIED", "denied", 403),
    });
    const res = await handleCreateBarrier(
      barrierReq(token, { type: "PA issue" }),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    expect(res.status).toBe(403);
  });

  it("SF_NETWORK_TIMEOUT → 503 SF_UPSTREAM_UNAVAILABLE", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient({
      createError: new SalesforceError(
        "SF_NETWORK_TIMEOUT",
        "Salesforce request timed out after 10000ms",
      ),
    });
    const res = await handleCreateBarrier(
      barrierReq(token, { type: "PA issue" }),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    expect(res.status).toBe(503);
  });
});

// ── priorityRecomputed best-effort ──────────────────────────────────────────

describe("handleCreateBarrier — priorityRecomputed degradation", () => {
  it("returns degraded shape when the scoring kernel throws", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient();
    const failingScore: NonNullable<
      CreateBarrierHandlerOptions["scoreCaseloadImpl"]
    > = vi.fn(() => Promise.reject(new Error("transient")));
    const res = await handleCreateBarrier(
      barrierReq(token, { type: "PA issue" }),
      routeCtx(),
      baseOptions(store, {
        restClient: client,
        scoreCaseloadImpl: failingScore,
      }),
    );
    // The Barrier still succeeded — degraded priorityRecomputed, not a 5xx.
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      priorityRecomputed: {
        participantId: string;
        score: number | null;
        tier: number | null;
        factors: unknown[];
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

  it("returns degraded shape when the kernel cannot score the participant (engine === null)", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient();
    const res = await handleCreateBarrier(
      barrierReq(token, { type: "PA issue" }),
      routeCtx(),
      baseOptions(store, {
        restClient: client,
        scoreCaseloadImpl: makeScoreCaseload(null),
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      priorityRecomputed: { score: number | null };
    };
    expect(body.priorityRecomputed.score).toBeNull();
  });
});

// ── idempotency replay (Pattern D) ──────────────────────────────────────────

describe("handleCreateBarrier — idempotency", () => {
  it("replay with the same key returns the cached response without re-running the handler (and emits exactly one audit row)", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client, createRecordFn } = makeRestClient();
    const idemStore = makeIdemStore();
    const capture = makeAuditCapture();
    const opts = baseOptions(store, {
      restClient: client,
      idempotencyStore: idemStore,
      writeAudit: capture.writer,
    });
    const res1 = await handleCreateBarrier(
      barrierReq(token, { type: "PA issue" }, IDEM_KEY),
      routeCtx(),
      opts,
    );
    const res2 = await handleCreateBarrier(
      barrierReq(token, { type: "PA issue" }, IDEM_KEY),
      routeCtx(),
      opts,
    );
    expect(res1.status).toBe(201);
    expect(res2.status).toBe(201);
    expect(createRecordFn).toHaveBeenCalledTimes(1); // not 2
    expect(res2.headers.get("X-Idempotent-Replay")).toBe("true");
    // Pattern D: the cached replay returns without re-running the handler,
    // so the audit row fires exactly once — not twice (Immutable #6).
    expect(capture.audits).toHaveLength(1);
  });

  it("different key, same body → handler runs again (no idempotent replay)", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client, createRecordFn } = makeRestClient();
    const idemStore = makeIdemStore();
    const opts = baseOptions(store, {
      restClient: client,
      idempotencyStore: idemStore,
    });
    await handleCreateBarrier(
      barrierReq(token, { type: "PA issue" }, IDEM_KEY),
      routeCtx(),
      opts,
    );
    await handleCreateBarrier(
      barrierReq(token, { type: "PA issue" }, IDEM_KEY_B),
      routeCtx(),
      opts,
    );
    expect(createRecordFn).toHaveBeenCalledTimes(2);
  });
});

// ── write-ordering invariant (Pattern B / Immutable #5) ────────────────────

describe("handleCreateBarrier — audit gates response (Pattern B / Immutable #5)", () => {
  it("response is 500 INTERNAL_ERROR when the SUCCESS audit write throws (audit row gates the response)", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client, createRecordFn } = makeRestClient();
    // The handler awaits writeAudit BEFORE constructing the 201 response. If
    // the audit write throws, the handler's outer catch turns it into 500 —
    // proves the response is gated on audit settlement. A passing 201 here
    // would mean we shipped a barrier mutation without a durable audit row.
    const failingWriter: NonNullable<CreateBarrierHandlerOptions["writeAudit"]> =
      vi.fn(() => Promise.reject(new Error("audit-write-failed")));
    const res = await handleCreateBarrier(
      barrierReq(token, { type: "PA issue" }),
      routeCtx(),
      baseOptions(store, { restClient: client, writeAudit: failingWriter }),
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("INTERNAL_ERROR");
    // Belt-and-braces: a future fire-and-forget refactor (`void writeAudit(...)`)
    // could still ship the 201 success body even when audit rejects. Pinning
    // the absence of `barrierId` makes that regression loudly fail.
    expect(body.barrierId).toBeUndefined();
    // SF write happened before the audit emission (success path) — the 500
    // therefore proves the response stage was gated on audit, not on SF.
    expect(createRecordFn).toHaveBeenCalledTimes(1);
    expect(failingWriter).toHaveBeenCalledTimes(1);
  });
});

// ── Pattern B PII firewall integration (real writeAuditEntry) ──────────────

describe("handleCreateBarrier — Pattern B PII firewall (real writer)", () => {
  it("the real assertNoPii in writeAuditEntry does not throw on our barrier.created metadata shape", async () => {
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

    const res = await handleCreateBarrier(
      barrierReq(token, { type: "PA issue", description: "free-text desc" }),
      routeCtx(),
      baseOptions(store, {
        restClient: client,
        db: fakeDb,
        writeAudit: writeAuditEntry,
      }),
    );
    expect(res.status).toBe(201);
    expect(insertedRows).toHaveLength(1);
    // Belt-and-braces: the inserted row also carries no free-text. A
    // bypass of assertNoPii that admitted the description to payload_metadata
    // would surface here even if the schema validator silently let it through.
    expect(JSON.stringify(insertedRows[0])).not.toContain("free-text desc");
  });
});

// Use of NOW_DATE keeps lint quiet about an unused fixture across describe
// blocks — `Start_Date__c` derives from `now()` in the happy-path suite.
void NOW_DATE;
void PARTICIPANT_SCORED;
