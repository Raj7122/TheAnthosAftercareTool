import { hashToken, loadSessionConfig, mintToken } from "@anthos/auth";
import type { Role } from "@anthos/auth";
import {
  SalesforceError,
  type SalesforceAuth,
  type SoqlQueryResponse,
  type CreateRecordResult,
} from "@anthos/integrations";
import type { DbOrTx } from "@anthos/persistence";
import { describe, expect, it, vi } from "vitest";

import { handleCreateRepair } from "../../src/repairs/create-repair.js";
import type { CreateRepairHandlerOptions } from "../../src/repairs/create-repair.js";
import type {
  IdempotencyRecord,
  IdempotencyStatus,
  IdempotencyStore,
} from "../../src/idempotency/store.js";
import type { SessionRecord, SessionStore } from "../../src/session/store.js";

// ── fixtures ────────────────────────────────────────────────────────────────

const SESSION_CONFIG = loadSessionConfig({});
const HOUR = 60 * 60 * 1000;
const SPECIALIST_ID = "0058K00000XYZAbQAO";
const OTHER_SPECIALIST_ID = "0058K00000QQQXXxQAO";
const PARTICIPANT_ID = "a015g00000ABCDxQAO";
const UNIT_RENTAL_ID = "a1kU800000pjmyDIAQ";
const IDEM_KEY = "11111111-1111-4111-8111-111111111111";
const IDEM_KEY_B = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-06-04T15:30:00Z");
const NOW_DATE = "2026-06-04";
const FAKE_DB = {} as unknown as DbOrTx;

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

// Mock M-SF rest client. The handler uses `query` TWICE — first the PE-owner
// lookup (`Aftercare_Owner__c FROM IDW_Program_Enrollment__c`), then the Unit
// Engagement resolution (`Id FROM Unit_Rental__c`) — and `createRecord` for the
// Repair write. The fake discriminates the two queries on the FROM clause.
function makeRestClient(
  opts: {
    ownerId?: string | null;
    peNotFound?: boolean;
    noUnitRental?: boolean;
    unitRentalId?: string;
    createResult?: CreateRecordResult;
    createError?: SalesforceError;
    peQueryError?: SalesforceError;
    unitQueryError?: SalesforceError;
  } = {},
) {
  const queryFn = vi.fn(async (soql: string) => {
    if (soql.includes("FROM Unit_Rental__c")) {
      if (opts.unitQueryError !== undefined) throw opts.unitQueryError;
      if (opts.noUnitRental) {
        return { totalSize: 0, done: true, records: [] } as SoqlQueryResponse<{
          Id: string;
        }>;
      }
      return {
        totalSize: 1,
        done: true,
        records: [{ Id: opts.unitRentalId ?? UNIT_RENTAL_ID }],
      } as SoqlQueryResponse<{ Id: string }>;
    }
    // PE owner lookup.
    if (opts.peQueryError !== undefined) throw opts.peQueryError;
    if (opts.peNotFound) {
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
        id: "a1J5g00000NEWxQAO",
        success: true,
        errors: [],
      }
    );
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
  writer: NonNullable<CreateRepairHandlerOptions["writeAudit"]>;
}

function makeAuditCapture(): AuditCapture {
  const audits: AuditCapture["audits"] = [];
  const writer: NonNullable<CreateRepairHandlerOptions["writeAudit"]> = vi.fn(
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

function repairReq(
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
    `https://bff.test/api/v1/participants/${participantId}/repairs`,
    { method: "POST", headers, body: JSON.stringify(body) },
  );
}

function routeCtx(participantId: string = PARTICIPANT_ID) {
  return { params: Promise.resolve({ id: participantId }) };
}

function baseOptions(
  store: SessionStore,
  overrides: Partial<CreateRepairHandlerOptions> = {},
): CreateRepairHandlerOptions {
  const audit = overrides.writeAudit ?? makeAuditCapture().writer;
  return {
    store,
    sessionConfig: SESSION_CONFIG,
    idempotencyStore: makeIdemStore(),
    db: FAKE_DB,
    writeAudit: audit,
    salesforceAuth: FAKE_AUTH,
    now: () => NOW,
    ...overrides,
  };
}

const NOTE_BODY = { note: "Leaky faucet in unit 4B" };

// ── auth + idempotency gates ────────────────────────────────────────────────

describe("handleCreateRepair — auth + idempotency gates", () => {
  it("401 when no session cookie is present", async () => {
    const { store } = makeStore();
    const { client } = makeRestClient();
    const res = await handleCreateRepair(
      repairReq(undefined, NOTE_BODY),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    expect(res.status).toBe(401);
  });

  it("400 IDEMPOTENCY_KEY_REQUIRED when header is missing", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient();
    const res = await handleCreateRepair(
      repairReq(token, NOTE_BODY, null),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe(
      "IDEMPOTENCY_KEY_REQUIRED",
    );
  });
});

// ── request validation ──────────────────────────────────────────────────────

describe("handleCreateRepair — request validation", () => {
  it("422 on missing note", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient();
    const res = await handleCreateRepair(
      repairReq(token, {}),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { details?: { field?: string } };
    expect(body.details?.field).toBe("note");
  });

  it("strict-object: rejects the retired noteDestination key", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient();
    const res = await handleCreateRepair(
      repairReq(token, { note: "x", noteDestination: "atc_notes" }),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    expect(res.status).toBe(422);
  });

  it("strict-object: rejects unknown keys (e.g. server-set status)", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient();
    const res = await handleCreateRepair(
      repairReq(token, { ...NOTE_BODY, status: "Completed" }),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    expect(res.status).toBe(422);
  });

  it("422 on invalid participant id shape", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient();
    const res = await handleCreateRepair(
      repairReq(token, NOTE_BODY, IDEM_KEY, "not-an-sf-id"),
      routeCtx("not-an-sf-id"),
      baseOptions(store, { restClient: client }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { details?: { field?: string } };
    expect(body.details?.field).toBe("participantId");
  });
});

// ── authz scope (BR-35, SEC-AUTHZ-3) ─────────────────────────────────────────

describe("handleCreateRepair — authz scope", () => {
  it("SPECIALIST + own PE → 201", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient({ ownerId: SPECIALIST_ID });
    const res = await handleCreateRepair(
      repairReq(token, NOTE_BODY),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    expect(res.status).toBe(201);
  });

  it("SPECIALIST + someone else's PE → 403 + no SF write", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client, createRecordFn } = makeRestClient({
      ownerId: OTHER_SPECIALIST_ID,
    });
    const res = await handleCreateRepair(
      repairReq(token, NOTE_BODY),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe(
      "NOT_IN_OWN_CASELOAD",
    );
    expect(createRecordFn).not.toHaveBeenCalled();
  });

  it("VP + any PE → 201", async () => {
    const { store, seed } = makeStore();
    const token = seed("VP");
    const { client } = makeRestClient({ ownerId: OTHER_SPECIALIST_ID });
    const res = await handleCreateRepair(
      repairReq(token, NOTE_BODY),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    expect(res.status).toBe(201);
  });

  it("SUPERVISOR → 403 supervisor_scope_unmapped", async () => {
    const { store, seed } = makeStore();
    const token = seed("SUPERVISOR");
    const { client, createRecordFn } = makeRestClient();
    const res = await handleCreateRepair(
      repairReq(token, NOTE_BODY),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { details?: { reason?: string } };
    expect(body.details?.reason).toBe("supervisor_scope_unmapped");
    expect(createRecordFn).not.toHaveBeenCalled();
  });

  it("SYSTEM_ADMIN → 403 role_not_permitted", async () => {
    const { store, seed } = makeStore();
    const token = seed("SYSTEM_ADMIN");
    const { client } = makeRestClient();
    const res = await handleCreateRepair(
      repairReq(token, NOTE_BODY),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { details?: { reason?: string } };
    expect(body.details?.reason).toBe("role_not_permitted");
  });

  it("404 when the PE is unknown", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client, createRecordFn } = makeRestClient({ peNotFound: true });
    const res = await handleCreateRepair(
      repairReq(token, NOTE_BODY),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    expect(res.status).toBe(404);
    expect(createRecordFn).not.toHaveBeenCalled();
  });
});

// ── Unit Engagement resolution + fallback ────────────────────────────────────

describe("handleCreateRepair — Unit Engagement link", () => {
  it("no Unit Engagement → 409 REPAIR_UNIT_ENGAGEMENT_MISSING + FAILED audit, no SF write", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client, createRecordFn } = makeRestClient({ noUnitRental: true });
    const capture = makeAuditCapture();
    const res = await handleCreateRepair(
      repairReq(token, NOTE_BODY),
      routeCtx(),
      baseOptions(store, { restClient: client, writeAudit: capture.writer }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      code: string;
      details?: { reason?: string };
    };
    expect(body.code).toBe("REPAIR_UNIT_ENGAGEMENT_MISSING");
    expect(body.details?.reason).toBe("no_unit_rental");
    expect(createRecordFn).not.toHaveBeenCalled();
    // Non-silent: the failed mutation attempt is audited.
    expect(capture.audits).toHaveLength(1);
    expect(capture.audits[0]).toMatchObject({
      actionType: "repair.created",
      outcome: "FAILED",
    });
    expect(capture.audits[0]?.payloadMetadata).toMatchObject({
      failure_phase: "unit_rental_resolution",
    });
  });

  it("attaches the resolved Unit_Rental__c id to the repair", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client, createRecordFn } = makeRestClient({
      unitRentalId: "a1kU800000ZZZZZIAA",
    });
    await handleCreateRepair(
      repairReq(token, NOTE_BODY),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    const [, payload] = createRecordFn.mock.calls[0]!;
    expect(payload).toMatchObject({ Unit_Rental__c: "a1kU800000ZZZZZIAA" });
  });
});

// ── happy path: server-set fields, note routing, response, audit ────────────

describe("handleCreateRepair — happy path", () => {
  it("server-sets Status + Identification_Date and routes the note to Description__c", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client, createRecordFn } = makeRestClient();
    await handleCreateRepair(
      repairReq(token, { note: "broken window" }),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    expect(createRecordFn).toHaveBeenCalledTimes(1);
    const [sobject, payload] = createRecordFn.mock.calls[0]!;
    expect(sobject).toBe("Repair__c");
    expect(payload).toMatchObject({
      Status__c: "Need Identified",
      Identification_Date__c: NOW_DATE,
      Unit_Rental__c: UNIT_RENTAL_ID,
      Description__c: "broken window",
    });
    expect(payload).not.toHaveProperty("Notes__c");
  });

  it("response echoes the repair fields including the note", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient({
      createResult: { id: "a1J5g00000REPxQAO", success: true, errors: [] },
    });
    const res = await handleCreateRepair(
      repairReq(token, NOTE_BODY),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      repairId: "a1J5g00000REPxQAO",
      participantId: PARTICIPANT_ID,
      unitRentalId: UNIT_RENTAL_ID,
      status: "Need Identified",
      identificationDate: NOW_DATE,
      note: "Leaky faucet in unit 4B",
      loggedBy: SPECIALIST_ID,
      loggedAt: NOW.toISOString(),
    });
  });

  it("SUCCESS audit metadata carries only {source} — never the note", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient();
    const capture = makeAuditCapture();
    const inboundTrace = "aaaaaaaa-bbbb-4ccc-8ddd-111111111111";
    const res = await handleCreateRepair(
      repairReq(
        token,
        { note: "sensitive repair detail here" },
        IDEM_KEY,
        PARTICIPANT_ID,
        inboundTrace,
      ),
      routeCtx(),
      baseOptions(store, { restClient: client, writeAudit: capture.writer }),
    );
    expect(res.status).toBe(201);
    expect(res.headers.get("X-Trace-Id")).toBe(inboundTrace);
    expect(capture.audits).toHaveLength(1);
    expect(capture.audits[0]).toMatchObject({
      actionType: "repair.created",
      outcome: "SUCCESS",
      specialistId: SPECIALIST_ID,
      participantId: PARTICIPANT_ID,
      salesforceRecordId: "a1J5g00000NEWxQAO",
      traceId: inboundTrace,
    });
    const metadata = capture.audits[0]!.payloadMetadata!;
    expect(metadata).toEqual({ source: "tool" });
    // No `note*` key (the no-PII denylist rejects them) and no note text.
    expect(JSON.stringify(metadata)).not.toContain("sensitive repair detail");
    expect(Object.keys(metadata).some((k) => k.includes("note"))).toBe(false);
  });
});

// ── Salesforce failure mapping ──────────────────────────────────────────────

describe("handleCreateRepair — Salesforce failures", () => {
  it("SF_VALIDATION_FAILED on createRecord → 422 + FAILED audit (failure_phase=create)", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient({
      createError: new SalesforceError("SF_VALIDATION_FAILED", "REQUIRED", 400),
    });
    const capture = makeAuditCapture();
    const res = await handleCreateRepair(
      repairReq(token, NOTE_BODY),
      routeCtx(),
      baseOptions(store, { restClient: client, writeAudit: capture.writer }),
    );
    expect(res.status).toBe(422);
    expect(capture.audits[0]).toMatchObject({
      actionType: "repair.created",
      outcome: "FAILED",
    });
    expect(capture.audits[0]?.payloadMetadata).toMatchObject({
      failure_phase: "create",
      sf_code: "SF_VALIDATION_FAILED",
    });
  });

  it("SF outage during authz-lookup → 503 + FAILED (failure_phase=authz_lookup), no create", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client, createRecordFn } = makeRestClient({
      peQueryError: new SalesforceError("SF_NETWORK_TIMEOUT", "timed out"),
    });
    const capture = makeAuditCapture();
    const res = await handleCreateRepair(
      repairReq(token, NOTE_BODY),
      routeCtx(),
      baseOptions(store, { restClient: client, writeAudit: capture.writer }),
    );
    expect(res.status).toBe(503);
    expect(capture.audits[0]?.payloadMetadata).toMatchObject({
      failure_phase: "authz_lookup",
      sf_code: "SF_NETWORK_TIMEOUT",
    });
    expect(createRecordFn).not.toHaveBeenCalled();
  });

  it("SF outage during Unit Engagement lookup → 503 + FAILED (failure_phase=unit_rental_resolution)", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client, createRecordFn } = makeRestClient({
      unitQueryError: new SalesforceError("SF_NETWORK_TIMEOUT", "timed out"),
    });
    const capture = makeAuditCapture();
    const res = await handleCreateRepair(
      repairReq(token, NOTE_BODY),
      routeCtx(),
      baseOptions(store, { restClient: client, writeAudit: capture.writer }),
    );
    expect(res.status).toBe(503);
    expect(capture.audits[0]?.payloadMetadata).toMatchObject({
      failure_phase: "unit_rental_resolution",
    });
    expect(createRecordFn).not.toHaveBeenCalled();
  });
});

// ── idempotency replay (Pattern D) ──────────────────────────────────────────

describe("handleCreateRepair — idempotency", () => {
  it("replay with the same key returns the cached response and emits exactly one audit row", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client, createRecordFn } = makeRestClient();
    const capture = makeAuditCapture();
    const opts = baseOptions(store, {
      restClient: client,
      idempotencyStore: makeIdemStore(),
      writeAudit: capture.writer,
    });
    const res1 = await handleCreateRepair(repairReq(token, NOTE_BODY, IDEM_KEY), routeCtx(), opts);
    const res2 = await handleCreateRepair(repairReq(token, NOTE_BODY, IDEM_KEY), routeCtx(), opts);
    expect(res1.status).toBe(201);
    expect(res2.status).toBe(201);
    expect(createRecordFn).toHaveBeenCalledTimes(1);
    expect(res2.headers.get("X-Idempotent-Replay")).toBe("true");
    expect(capture.audits).toHaveLength(1);
  });

  it("different key → handler runs again", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client, createRecordFn } = makeRestClient();
    const opts = baseOptions(store, {
      restClient: client,
      idempotencyStore: makeIdemStore(),
    });
    await handleCreateRepair(repairReq(token, NOTE_BODY, IDEM_KEY), routeCtx(), opts);
    await handleCreateRepair(repairReq(token, NOTE_BODY, IDEM_KEY_B), routeCtx(), opts);
    expect(createRecordFn).toHaveBeenCalledTimes(2);
  });
});

// ── write-ordering invariant (Pattern B / Immutable #5) ─────────────────────

describe("handleCreateRepair — audit gates response", () => {
  it("500 INTERNAL_ERROR when the SUCCESS audit write throws", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client, createRecordFn } = makeRestClient();
    const failingWriter: NonNullable<CreateRepairHandlerOptions["writeAudit"]> =
      vi.fn(() => Promise.reject(new Error("audit-write-failed")));
    const res = await handleCreateRepair(
      repairReq(token, NOTE_BODY),
      routeCtx(),
      baseOptions(store, { restClient: client, writeAudit: failingWriter }),
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("INTERNAL_ERROR");
    expect(body.repairId).toBeUndefined();
    expect(createRecordFn).toHaveBeenCalledTimes(1);
  });
});

// ── Pattern B PII firewall integration (real writeAuditEntry) ───────────────

describe("handleCreateRepair — Pattern B PII firewall (real writer)", () => {
  it("the real assertNoPii does not throw on the repair.created metadata shape", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient();
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

    const res = await handleCreateRepair(
      repairReq(token, { note: "free-text repair note" }),
      routeCtx(),
      baseOptions(store, {
        restClient: client,
        db: fakeDb,
        writeAudit: writeAuditEntry,
      }),
    );
    expect(res.status).toBe(201);
    expect(insertedRows).toHaveLength(1);
    expect(JSON.stringify(insertedRows[0])).not.toContain("free-text repair note");
  });
});
