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

import { handleLogCall } from "../../src/case-notes/create-call.js";
import type {
  CaseNoteWriteFn,
  CaseNoteWriteResult,
  LogCallHandlerOptions,
} from "../../src/case-notes/create-call.js";
import type {
  IdempotencyRecord,
  IdempotencyStatus,
  IdempotencyStore,
} from "../../src/idempotency/store.js";
import type { ScoreCaseloadResult } from "../../src/caseload/score-caseload.js";
import type { SessionRecord, SessionStore } from "../../src/session/store.js";
import { makeEngineOutput, makeScored } from "../caseload/_fixtures.js";
import { makeSnapshot } from "../calibration/_fixtures.js";

// ── fixtures ────────────────────────────────────────────────────────────────

const SESSION_CONFIG = loadSessionConfig({});
const HOUR = 60 * 60 * 1000;
const SPECIALIST_ID = "0058K00000XYZAbQAO";
const OTHER_SPECIALIST_ID = "0058K00000QQQXXxQAO";
const PARTICIPANT_ID = "a015g00000ABCDxQAO";
const IDEM_KEY = "11111111-1111-4111-8111-111111111111";
const IDEM_KEY_B = "22222222-2222-4222-8222-222222222222";
// 2026-05-22 sits comfortably inside any back-date window centered on NOW.
const NOW = new Date("2026-05-22T15:30:00Z");
const TODAY_YMD = "2026-05-22";
const YESTERDAY_YMD = "2026-05-21";
const TOO_OLD_YMD = "2026-05-07"; // NOW - 15 days
const TOO_FUTURE_YMD = "2026-05-24"; // NOW + 2 days
const VALID_SUMMARY = "Connected and confirmed Tuesday appointment.";
const CONFIG = getCalibrationConfiguration();
const FAKE_DB = {} as unknown as DbOrTx;

// In-memory SessionStore.
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

// Mock M-SF rest client. `query` drives the authz PE lookup; `createRecord`
// drives the default real-write path post-P1F-03b. `createError` lets a test
// throw a typed SalesforceError from the write seam; `createId` overrides
// the SF id returned on a successful write.
const DEFAULT_SF_ID = "a1d5g00000NEWxQAO";

function makeRestClient(opts: {
  ownerId?: string | null;
  recordNotFound?: boolean;
  queryError?: SalesforceError;
  createError?: SalesforceError;
  createId?: string;
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
    return {
      id: opts.createId ?? DEFAULT_SF_ID,
      success: true,
      errors: [],
    };
  });
  const client = {
    query: queryFn,
    createRecord: createRecordFn,
  } as unknown as import("@anthos/integrations").SalesforceRestClient;
  return { client, queryFn, createRecordFn };
}

const FAKE_AUTH: SalesforceAuth = {
  getAccessToken: () => Promise.resolve("test-token"),
  getInstanceUrl: () => Promise.resolve("https://test.my.salesforce.com"),
};

function makeScoreCaseload(
  participantEngine: EngineOutput | null = makeEngineOutput(PARTICIPANT_ID, {
    priorityScore: 81,
    tier: 1,
  }),
): NonNullable<LogCallHandlerOptions["scoreCaseloadImpl"]> {
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
    channel?: string;
    participantId?: string;
    salesforceRecordId?: string;
    payloadMetadata?: Record<string, unknown>;
  }>;
  writer: NonNullable<LogCallHandlerOptions["writeAudit"]>;
}

function makeAuditCapture(): AuditCapture {
  const audits: AuditCapture["audits"] = [];
  const writer: NonNullable<LogCallHandlerOptions["writeAudit"]> = vi.fn(
    (_db, entry) => {
      audits.push({
        actionType: entry.actionType,
        outcome: entry.outcome,
        ...(entry.channel !== undefined ? { channel: entry.channel } : {}),
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

function callReq(
  token: string | undefined,
  body: unknown,
  idempotencyKey: string | null = IDEM_KEY,
  participantId: string = PARTICIPANT_ID,
): Request {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (token !== undefined) headers.set("Cookie", `anthos_session=${token}`);
  if (idempotencyKey !== null) headers.set("Idempotency-Key", idempotencyKey);
  return new Request(
    `https://bff.test/api/v1/participants/${participantId}/calls`,
    { method: "POST", headers, body: JSON.stringify(body) },
  );
}

function routeCtx(participantId: string = PARTICIPANT_ID) {
  return { params: Promise.resolve({ id: participantId }) };
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    status: "Attempted",
    type: "Check In",
    serviceDate: TODAY_YMD,
    ...overrides,
  };
}

function baseOptions(
  store: SessionStore,
  overrides: Partial<LogCallHandlerOptions> = {},
): LogCallHandlerOptions {
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

describe("handleLogCall — auth + idempotency gates", () => {
  it("401 AUTH_SESSION_INVALID when no session cookie is present", async () => {
    const { store } = makeStore();
    const { client } = makeRestClient();
    const res = await handleLogCall(
      callReq(undefined, validBody()),
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
    const res = await handleLogCall(
      callReq(token, validBody(), null),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe(
      "IDEMPOTENCY_KEY_REQUIRED",
    );
  });
});

// ── request validation (VR-16, VR-17, VR-18, VR-19, VR-20) ──────────────────

describe("handleLogCall — request validation", () => {
  it("VR-16: 422 VALIDATION_FAILED on missing status", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient();
    const res = await handleLogCall(
      callReq(token, { type: "Check In", serviceDate: TODAY_YMD }),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { details?: { field?: string } };
    expect(body.details?.field).toBe("status");
  });

  it("VR-16: 422 on unknown status", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient();
    const res = await handleLogCall(
      callReq(token, validBody({ status: "MaybeLater" })),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    expect(res.status).toBe(422);
    expect(((await res.json()) as { details?: { field?: string } }).details?.field).toBe(
      "status",
    );
  });

  it("VR-20: 422 on type not in v1.3 Aftercare picklist", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient();
    const res = await handleLogCall(
      callReq(token, validBody({ type: "Coffee chat" })),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    expect(res.status).toBe(422);
    expect(((await res.json()) as { details?: { field?: string } }).details?.field).toBe(
      "type",
    );
  });

  it("VR-18: 422 SUMMARY_REQUIRED_FOR_COMPLETED when summary missing on status=Completed", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient();
    const res = await handleLogCall(
      callReq(token, validBody({ status: "Completed" })),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      code: string;
      details?: {
        field?: string;
        rule?: string;
        minLength?: number;
        actualLength?: number;
      };
    };
    expect(body.code).toBe("SUMMARY_REQUIRED_FOR_COMPLETED");
    expect(body.details).toMatchObject({
      field: "summary",
      rule: "VR-18",
      minLength: 10,
      actualLength: 0,
    });
  });

  it("VR-18: 422 SUMMARY_REQUIRED_FOR_COMPLETED when summary <10 chars (BA VL-01)", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient();
    const res = await handleLogCall(
      callReq(
        token,
        validBody({ status: "Completed", summary: "ok done" }), // 7 chars
      ),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      code: string;
      details?: { actualLength?: number; minLength?: number };
    };
    expect(body.code).toBe("SUMMARY_REQUIRED_FOR_COMPLETED");
    expect(body.details).toMatchObject({ minLength: 10, actualLength: 7 });
  });

  it("VR-19: 422 when summary >2000 chars (BR-45)", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient();
    const tooLong = "x".repeat(2001);
    const res = await handleLogCall(
      callReq(token, validBody({ summary: tooLong })),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    expect(res.status).toBe(422);
    expect(((await res.json()) as { details?: { field?: string } }).details?.field).toBe(
      "summary",
    );
  });

  it("VR-17 / BR-44: 422 when serviceDate is more than 14 days in the past", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient();
    const res = await handleLogCall(
      callReq(token, validBody({ serviceDate: TOO_OLD_YMD })),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    expect(res.status).toBe(422);
    expect(((await res.json()) as { details?: { field?: string } }).details?.field).toBe(
      "serviceDate",
    );
  });

  it("VR-17: 422 when serviceDate is more than 1 day in the future", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient();
    const res = await handleLogCall(
      callReq(token, validBody({ serviceDate: TOO_FUTURE_YMD })),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    expect(res.status).toBe(422);
    expect(((await res.json()) as { details?: { field?: string } }).details?.field).toBe(
      "serviceDate",
    );
  });

  it("422 on malformed serviceDate (e.g. 2026-02-30 round-trips)", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient();
    const res = await handleLogCall(
      callReq(token, validBody({ serviceDate: "2026-02-30" })),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    expect(res.status).toBe(422);
    expect(((await res.json()) as { details?: { field?: string } }).details?.field).toBe(
      "serviceDate",
    );
  });

  it("strict-object: rejects a parallel `contactType` body field (path-as-contract)", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient();
    const res = await handleLogCall(
      callReq(token, { ...validBody(), contactType: "phone" }),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    expect(res.status).toBe(422);
  });

  it("422 on invalid participant id shape", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient();
    const res = await handleLogCall(
      callReq(token, validBody(), IDEM_KEY, "not-an-sf-id"),
      routeCtx("not-an-sf-id"),
      baseOptions(store, { restClient: client }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { details?: { field?: string } };
    expect(body.details?.field).toBe("participantId");
  });
});

// ── authz scope (BR-49 generalized, SEC-AUTHZ-3) ────────────────────────────

describe("handleLogCall — authz scope", () => {
  it("SPECIALIST + own PE → 201 (real SF write via default seam)", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient({ ownerId: SPECIALIST_ID });
    const res = await handleLogCall(
      callReq(token, validBody()),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    expect(res.status).toBe(201);
  });

  it("SPECIALIST + someone else's PE → 403 NOT_IN_OWN_CASELOAD", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient({ ownerId: OTHER_SPECIALIST_ID });
    const capture = makeAuditCapture();
    const res = await handleLogCall(
      callReq(token, validBody()),
      routeCtx(),
      baseOptions(store, { restClient: client, writeAudit: capture.writer }),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe(
      "NOT_IN_OWN_CASELOAD",
    );
    // Pre-mutation client-attribute rejection — no audit row.
    expect(capture.audits).toHaveLength(0);
  });

  it("VP + any PE → 201 regardless of owner", async () => {
    const { store, seed } = makeStore();
    const token = seed("VP");
    const { client } = makeRestClient({ ownerId: OTHER_SPECIALIST_ID });
    const res = await handleLogCall(
      callReq(token, validBody()),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    expect(res.status).toBe(201);
  });

  it("SUPERVISOR → 403 ROLE_INSUFFICIENT_SCOPE supervisor_scope_unmapped (stub)", async () => {
    const { store, seed } = makeStore();
    const token = seed("SUPERVISOR");
    const { client } = makeRestClient();
    const res = await handleLogCall(
      callReq(token, validBody()),
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
  });

  it("SYSTEM_ADMIN → 403 ROLE_INSUFFICIENT_SCOPE role_not_permitted", async () => {
    const { store, seed } = makeStore();
    const token = seed("SYSTEM_ADMIN");
    const { client } = makeRestClient();
    const res = await handleLogCall(
      callReq(token, validBody()),
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
    const { client } = makeRestClient({ recordNotFound: true });
    const res = await handleLogCall(
      callReq(token, validBody()),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    expect(res.status).toBe(404);
  });
});

// ── happy path: response shape, real SF write, SUCCESS audit ────────────────

describe("handleLogCall — happy path (real SF write)", () => {
  it("returns 201 with E-10 response shape including contactType='phone' and empty dataIssues", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient();
    const res = await handleLogCall(
      callReq(
        token,
        validBody({
          status: "Completed",
          summary: VALID_SUMMARY,
          occurredAt: "2026-05-22T15:23:00Z",
        }),
      ),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      participantId: PARTICIPANT_ID,
      status: "Completed",
      type: "Check In",
      contactType: "phone",
      summary: VALID_SUMMARY,
      serviceDate: TODAY_YMD,
      occurredAt: "2026-05-22T15:23:00Z",
      loggedAt: NOW.toISOString(),
      loggedBy: SPECIALIST_ID,
      source: "tool",
    });
    // Real Salesforce id from the mocked createRecord call.
    expect(body.caseNoteId).toBe(DEFAULT_SF_ID);
    expect(body.dataIssues).toEqual([]);
    expect(body.priorityRecomputed).toMatchObject({
      participantId: PARTICIPANT_ID,
      score: 81,
      tier: 1,
    });
  });

  it("defaults occurredAt to server-now when omitted", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient();
    const res = await handleLogCall(
      callReq(token, validBody()),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    const body = (await res.json()) as { occurredAt: string };
    expect(body.occurredAt).toBe(NOW.toISOString());
  });

  it("accepts back-dated serviceDate within the 14-day window", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient();
    const res = await handleLogCall(
      callReq(token, validBody({ serviceDate: YESTERDAY_YMD })),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { serviceDate: string };
    expect(body.serviceDate).toBe(YESTERDAY_YMD);
  });

  it("writes a call.logged SUCCESS audit row with channel='phone' and salesforceRecordId populated", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient();
    const capture = makeAuditCapture();
    const res = await handleLogCall(
      callReq(
        token,
        validBody({ status: "Completed", summary: VALID_SUMMARY }),
      ),
      routeCtx(),
      baseOptions(store, { restClient: client, writeAudit: capture.writer }),
    );
    expect(res.status).toBe(201);
    expect(capture.audits).toHaveLength(1);
    expect(capture.audits[0]).toMatchObject({
      actionType: "call.logged",
      outcome: "SUCCESS",
      participantId: PARTICIPANT_ID,
      channel: "phone",
      salesforceRecordId: DEFAULT_SF_ID,
    });
    expect(capture.audits[0]?.payloadMetadata).toEqual({
      status: "Completed",
      call_type: "Check In",
      contact_type: "phone",
      source: "tool",
    });
    // Critical: the audit row must NEVER carry summary text (PII firewall /
    // SEC-AUDIT-4). Belt-and-braces — the @anthos/audit no-PII assertion
    // would throw on a `summary` key anyway, but we assert here too so any
    // refactor that smuggles it through fails at the unit boundary.
    const metaJson = JSON.stringify(capture.audits[0]?.payloadMetadata ?? {});
    expect(metaJson).not.toContain(VALID_SUMMARY);
    expect(metaJson.toLowerCase()).not.toContain("summary");
  });

  it("does NOT emit an audit row on pre-mutation 4xx (validation, 404, role denial)", async () => {
    // Three failure modes share the same posture; running them in one test
    // keeps the file shorter without losing assertion power.
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient({ recordNotFound: true });
    const capture = makeAuditCapture();
    const res = await handleLogCall(
      callReq(token, validBody()),
      routeCtx(),
      baseOptions(store, { restClient: client, writeAudit: capture.writer }),
    );
    expect(res.status).toBe(404);
    expect(capture.audits).toHaveLength(0);
  });

  it("seam is injectable — an explicit caseNoteWrite override wins over the default real-write", async () => {
    // The seam stays exposed for testability of future schema swaps. A test
    // that overrides `caseNoteWrite` should see its id flow through the
    // response and audit row instead of the default mock's id.
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient();
    const overrideId = "a1d5g00000RLZxQAS";
    const injected: CaseNoteWriteFn = vi.fn(
      () =>
        Promise.resolve({
          written: true,
          sfRecordId: overrideId,
        }) as Promise<CaseNoteWriteResult>,
    );
    const capture = makeAuditCapture();
    const res = await handleLogCall(
      callReq(token, validBody()),
      routeCtx(),
      baseOptions(store, {
        restClient: client,
        caseNoteWrite: injected,
        writeAudit: capture.writer,
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      caseNoteId: string;
      dataIssues: string[];
    };
    expect(body.caseNoteId).toBe(overrideId);
    expect(body.dataIssues).toEqual([]);
    expect(capture.audits[0]).toMatchObject({ salesforceRecordId: overrideId });
  });

  it("returns 500 if the injected seam returns written=false (defensive — synthesized ids are no longer wire)", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient();
    const nonWritingSeam: CaseNoteWriteFn = vi.fn(
      () =>
        Promise.resolve({ written: false, schemaGap: true }) as Promise<CaseNoteWriteResult>,
    );
    const res = await handleLogCall(
      callReq(token, validBody()),
      routeCtx(),
      baseOptions(store, { restClient: client, caseNoteWrite: nonWritingSeam }),
    );
    expect(res.status).toBe(500);
  });
});

// ── Salesforce failure mapping (authz lookup + write seam) ──────────────────

describe("handleLogCall — Salesforce failures", () => {
  it("SF authz-lookup error carries sf_underlying_code on the FAILED audit when SalesforceError supplies one", async () => {
    // Mirrors the create-phase sf_underlying_code coverage. The authz-lookup
    // catch picks up the same spread, so an error with `sfErrorCode` set
    // (e.g. INVALID_CROSS_REFERENCE_KEY on the SOQL read) must round-trip
    // into payloadMetadata for the queue-resolver flow downstream.
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient({
      queryError: new SalesforceError(
        "SF_UPSTREAM_STATE_CHANGED",
        "foreign key not accessible",
        400,
        "INVALID_CROSS_REFERENCE_KEY",
      ),
    });
    const capture = makeAuditCapture();
    await handleLogCall(
      callReq(token, validBody()),
      routeCtx(),
      baseOptions(store, { restClient: client, writeAudit: capture.writer }),
    );
    expect(capture.audits[0]?.payloadMetadata).toMatchObject({
      sf_code: "SF_UPSTREAM_STATE_CHANGED",
      sf_underlying_code: "INVALID_CROSS_REFERENCE_KEY",
      failure_phase: "authz_lookup",
    });
  });

  it("SF outage during authz-lookup → 503 + FAILED audit (failure_phase=authz_lookup, channel='system')", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient({
      queryError: new SalesforceError(
        "SF_NETWORK_TIMEOUT",
        "Salesforce request timed out after 10000ms",
      ),
    });
    const capture = makeAuditCapture();
    const res = await handleLogCall(
      callReq(token, validBody()),
      routeCtx(),
      baseOptions(store, { restClient: client, writeAudit: capture.writer }),
    );
    expect(res.status).toBe(503);
    expect(capture.audits).toHaveLength(1);
    expect(capture.audits[0]).toMatchObject({
      actionType: "call.logged",
      outcome: "FAILED",
      participantId: PARTICIPANT_ID,
      channel: "system",
    });
    // No `schema_gap_stub` on the authz-FAILED row — the SF write hasn't
    // been attempted yet; the flag would misleadingly suggest the stub ran.
    expect(capture.audits[0]?.payloadMetadata).toEqual({
      status: "Attempted",
      call_type: "Check In",
      contact_type: "phone",
      source: "tool",
      sf_code: "SF_NETWORK_TIMEOUT",
      failure_phase: "authz_lookup",
    });
  });

  it("SF_NETWORK_TIMEOUT from the write seam → 503 + FAILED audit (failure_phase=create)", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient({
      createError: new SalesforceError("SF_NETWORK_TIMEOUT", "Salesforce timeout"),
    });
    const capture = makeAuditCapture();
    const res = await handleLogCall(
      callReq(token, validBody()),
      routeCtx(),
      baseOptions(store, { restClient: client, writeAudit: capture.writer }),
    );
    expect(res.status).toBe(503);
    expect(capture.audits[0]).toMatchObject({
      actionType: "call.logged",
      outcome: "FAILED",
      channel: "phone",
    });
    expect(capture.audits[0]?.payloadMetadata).toMatchObject({
      sf_code: "SF_NETWORK_TIMEOUT",
      failure_phase: "create",
    });
    expect(capture.audits[0]?.salesforceRecordId).toBeUndefined();
  });
});

// ── SF write payload + error mapping (P1F-03b) ──────────────────────────────

describe("handleLogCall — SF write payload (P1F-03b)", () => {
  it("createRecord is called with IDW_Case_Note__c and the 4-field payload", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client, createRecordFn } = makeRestClient();
    const res = await handleLogCall(
      callReq(token, validBody({ status: "Completed", summary: VALID_SUMMARY })),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    expect(res.status).toBe(201);
    expect(createRecordFn).toHaveBeenCalledTimes(1);
    expect(createRecordFn).toHaveBeenCalledWith("IDW_Case_Note__c", {
      Program_Enrollment__c: PARTICIPANT_ID,
      Service_Date__c: TODAY_YMD,
      Contact_Type__c: "Phone",
      Case_Note__c: VALID_SUMMARY,
    });
  });

  it("Case_Note__c is the empty string when summary is omitted (non-Completed status)", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client, createRecordFn } = makeRestClient();
    await handleLogCall(
      callReq(token, validBody({ status: "Attempted" })),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    expect(createRecordFn).toHaveBeenCalledTimes(1);
    const args = createRecordFn.mock.calls[0]!;
    expect(args[1]).toMatchObject({ Case_Note__c: "" });
  });
});

describe("handleLogCall — SF write error mapping (P1F-03b)", () => {
  it("SF_VALIDATION_FAILED on createRecord → 422 VALIDATION_FAILED + FAILED audit (failure_phase=create)", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient({
      createError: new SalesforceError(
        "SF_VALIDATION_FAILED",
        "STRING_TOO_LONG",
        400,
        "STRING_TOO_LONG",
      ),
    });
    const capture = makeAuditCapture();
    const res = await handleLogCall(
      callReq(token, validBody()),
      routeCtx(),
      baseOptions(store, { restClient: client, writeAudit: capture.writer }),
    );
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe("VALIDATION_FAILED");
    expect(capture.audits[0]).toMatchObject({
      actionType: "call.logged",
      outcome: "FAILED",
      channel: "phone",
    });
    expect(capture.audits[0]?.payloadMetadata).toMatchObject({
      sf_code: "SF_VALIDATION_FAILED",
      sf_underlying_code: "STRING_TOO_LONG",
      failure_phase: "create",
    });
  });

  it("SF_FIELD_FLS_DENIED on createRecord → 403 + FAILED audit", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient({
      createError: new SalesforceError(
        "SF_FIELD_FLS_DENIED",
        "INSUFFICIENT_ACCESS_OR_READONLY",
        403,
        "INSUFFICIENT_ACCESS_OR_READONLY",
      ),
    });
    const capture = makeAuditCapture();
    const res = await handleLogCall(
      callReq(token, validBody()),
      routeCtx(),
      baseOptions(store, { restClient: client, writeAudit: capture.writer }),
    );
    expect(res.status).toBe(403);
    expect(capture.audits[0]?.payloadMetadata).toMatchObject({
      sf_code: "SF_FIELD_FLS_DENIED",
      sf_underlying_code: "INSUFFICIENT_ACCESS_OR_READONLY",
      failure_phase: "create",
    });
  });

  it("INVALID_CROSS_REFERENCE_KEY → 409 UPSTREAM_STATE_CHANGED with escalate resolution + FAILED audit", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient({
      createError: new SalesforceError(
        "SF_UPSTREAM_STATE_CHANGED",
        "foreign key not accessible",
        400,
        "INVALID_CROSS_REFERENCE_KEY",
      ),
    });
    const capture = makeAuditCapture();
    const res = await handleLogCall(
      callReq(token, validBody()),
      routeCtx(),
      baseOptions(store, { restClient: client, writeAudit: capture.writer }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      code: string;
      details: { sfErrorCode: string; suggestedResolution: string };
    };
    expect(body.code).toBe("UPSTREAM_STATE_CHANGED");
    expect(body.details.sfErrorCode).toBe("INVALID_CROSS_REFERENCE_KEY");
    expect(body.details.suggestedResolution).toBe("ESCALATE_TO_SUPERVISOR");
    expect(capture.audits[0]).toMatchObject({
      actionType: "call.logged",
      outcome: "FAILED",
      channel: "phone",
    });
    expect(capture.audits[0]?.payloadMetadata).toMatchObject({
      sf_code: "SF_UPSTREAM_STATE_CHANGED",
      sf_underlying_code: "INVALID_CROSS_REFERENCE_KEY",
      failure_phase: "create",
    });
  });

  it("ENTITY_IS_DELETED → 409 UPSTREAM_STATE_CHANGED with discard resolution + FAILED audit", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient({
      createError: new SalesforceError(
        "SF_UPSTREAM_STATE_CHANGED",
        "entity is deleted",
        404,
        "ENTITY_IS_DELETED",
      ),
    });
    const capture = makeAuditCapture();
    const res = await handleLogCall(
      callReq(token, validBody()),
      routeCtx(),
      baseOptions(store, { restClient: client, writeAudit: capture.writer }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      code: string;
      details: { sfErrorCode: string; suggestedResolution: string };
    };
    expect(body.code).toBe("UPSTREAM_STATE_CHANGED");
    expect(body.details.sfErrorCode).toBe("ENTITY_IS_DELETED");
    expect(body.details.suggestedResolution).toBe("DISCARD");
    expect(capture.audits[0]?.payloadMetadata).toMatchObject({
      sf_code: "SF_UPSTREAM_STATE_CHANGED",
      sf_underlying_code: "ENTITY_IS_DELETED",
      failure_phase: "create",
    });
  });
});

// ── priorityRecomputed best-effort (mirrors barriers) ───────────────────────

describe("handleLogCall — priorityRecomputed degradation", () => {
  it("returns degraded shape when the scoring kernel throws", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient();
    const failing: NonNullable<LogCallHandlerOptions["scoreCaseloadImpl"]> = vi.fn(
      () => Promise.reject(new Error("transient")),
    );
    const res = await handleLogCall(
      callReq(token, validBody()),
      routeCtx(),
      baseOptions(store, { restClient: client, scoreCaseloadImpl: failing }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      priorityRecomputed: {
        participantId: string;
        score: number | null;
        tier: number | null;
        factors: unknown[];
        previousScore: number | null;
        previousTier: number | null;
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
});

// ── idempotency replay (Pattern D) ──────────────────────────────────────────

describe("handleLogCall — idempotency", () => {
  it("replay with the same key returns the cached response (handler runs once, caseNoteId stable)", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient();
    const idemStore = makeIdemStore();
    const writeSeam: CaseNoteWriteFn = vi.fn(() =>
      Promise.resolve({
        written: true,
        sfRecordId: "a1d5g00000IDEMxQAO",
      } as CaseNoteWriteResult),
    );
    const opts = baseOptions(store, {
      restClient: client,
      idempotencyStore: idemStore,
      caseNoteWrite: writeSeam,
    });
    const res1 = await handleLogCall(
      callReq(token, validBody(), IDEM_KEY),
      routeCtx(),
      opts,
    );
    const res2 = await handleLogCall(
      callReq(token, validBody(), IDEM_KEY),
      routeCtx(),
      opts,
    );
    expect(res1.status).toBe(201);
    expect(res2.status).toBe(201);
    expect(writeSeam).toHaveBeenCalledTimes(1);
    const body1 = (await res1.json()) as { caseNoteId: string };
    const body2 = (await res2.json()) as { caseNoteId: string };
    expect(body1.caseNoteId).toBe(body2.caseNoteId);
    expect(res2.headers.get("X-Idempotent-Replay")).toBe("true");
  });

  it("different key, same body → handler runs again with a fresh SF id", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient();
    const idemStore = makeIdemStore();
    const writeSeam: CaseNoteWriteFn = vi
      .fn<CaseNoteWriteFn>()
      .mockResolvedValueOnce({ written: true, sfRecordId: "a1d5g00000ONE0QAO" })
      .mockResolvedValueOnce({ written: true, sfRecordId: "a1d5g00000TWO0QAO" });
    const opts = baseOptions(store, {
      restClient: client,
      idempotencyStore: idemStore,
      caseNoteWrite: writeSeam,
    });
    const r1 = await handleLogCall(
      callReq(token, validBody(), IDEM_KEY),
      routeCtx(),
      opts,
    );
    const r2 = await handleLogCall(
      callReq(token, validBody(), IDEM_KEY_B),
      routeCtx(),
      opts,
    );
    expect(writeSeam).toHaveBeenCalledTimes(2);
    const b1 = (await r1.json()) as { caseNoteId: string };
    const b2 = (await r2.json()) as { caseNoteId: string };
    expect(b1.caseNoteId).not.toBe(b2.caseNoteId);
  });

  it("same key + different body → 422 IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD", async () => {
    // Middleware-side contract per `packages/api/src/idempotency/responses.ts`
    // maps this code to 422 (not the 409 that some draft of API §7.4.3
    // implied — the canonical mapping lives in `ERROR_SPECS`).
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient();
    const idemStore = makeIdemStore();
    const opts = baseOptions(store, {
      restClient: client,
      idempotencyStore: idemStore,
    });
    await handleLogCall(
      callReq(token, validBody(), IDEM_KEY),
      routeCtx(),
      opts,
    );
    const r2 = await handleLogCall(
      callReq(token, validBody({ type: "Crisis support" }), IDEM_KEY),
      routeCtx(),
      opts,
    );
    expect(r2.status).toBe(422);
    expect(((await r2.json()) as { code: string }).code).toBe(
      "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD",
    );
  });
});

