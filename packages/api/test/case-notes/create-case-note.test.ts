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

import { handleCreateCaseNote } from "../../src/case-notes/create-case-note.js";
import type { CreateCaseNoteHandlerOptions } from "../../src/case-notes/create-case-note.js";
import type {
  IdempotencyRecord,
  IdempotencyStatus,
  IdempotencyStore,
} from "../../src/idempotency/store.js";
import type { SessionRecord, SessionStore } from "../../src/session/store.js";

const SESSION_CONFIG = loadSessionConfig({});
const HOUR = 60 * 60 * 1000;
const SPECIALIST_ID = "0058K00000XYZAbQAO";
const OTHER_SPECIALIST_ID = "0058K00000QQQXXxQAO";
const PARTICIPANT_ID = "a015g00000ABCDxQAO";
const IDEM_KEY = "11111111-1111-4111-8111-111111111111";
const IDEM_KEY_B = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-06-04T15:30:00Z");
const NOW_DATE = "2026-06-04";
const FAKE_DB = {} as unknown as DbOrTx;

const VALID_BODY = {
  note: "Met with client; rent stable",
  contactType: "Phone",
  type: "Check In",
  status: "Completed",
};

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

function makeRestClient(
  opts: {
    ownerId?: string | null;
    peNotFound?: boolean;
    createResult?: CreateRecordResult;
    createError?: SalesforceError;
    queryError?: SalesforceError;
  } = {},
) {
  const queryFn = vi.fn(async (_soql: string) => {
    if (opts.queryError !== undefined) throw opts.queryError;
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
        id: "a1dE2E0NEWxQAO12",
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
  writer: NonNullable<CreateCaseNoteHandlerOptions["writeAudit"]>;
}

function makeAuditCapture(): AuditCapture {
  const audits: AuditCapture["audits"] = [];
  const writer: NonNullable<CreateCaseNoteHandlerOptions["writeAudit"]> = vi.fn(
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

function caseNoteReq(
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
    `https://bff.test/api/v1/participants/${participantId}/case-notes`,
    { method: "POST", headers, body: JSON.stringify(body) },
  );
}

function routeCtx(participantId: string = PARTICIPANT_ID) {
  return { params: Promise.resolve({ id: participantId }) };
}

function baseOptions(
  store: SessionStore,
  overrides: Partial<CreateCaseNoteHandlerOptions> = {},
): CreateCaseNoteHandlerOptions {
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

describe("handleCreateCaseNote — auth + idempotency gates", () => {
  it("401 when no session cookie is present", async () => {
    const { store } = makeStore();
    const { client } = makeRestClient();
    const res = await handleCreateCaseNote(
      caseNoteReq(undefined, VALID_BODY),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    expect(res.status).toBe(401);
  });

  it("400 IDEMPOTENCY_KEY_REQUIRED when header is missing", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient();
    const res = await handleCreateCaseNote(
      caseNoteReq(token, VALID_BODY, null),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    expect(res.status).toBe(400);
  });
});

describe("handleCreateCaseNote — request validation", () => {
  it("422 on missing note", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient();
    const res = await handleCreateCaseNote(
      caseNoteReq(token, { contactType: "Phone", type: "Check In", status: "Completed" }),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { details?: { field?: string } };
    expect(body.details?.field).toBe("note");
  });

  it("422 on unknown contactType / type / status", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient();
    for (const bad of [
      { ...VALID_BODY, contactType: "Carrier Pigeon" },
      { ...VALID_BODY, type: "Not a real type" },
      { ...VALID_BODY, status: "Maybe" },
    ]) {
      const res = await handleCreateCaseNote(
        caseNoteReq(token, bad),
        routeCtx(),
        baseOptions(store, { restClient: client }),
      );
      expect(res.status).toBe(422);
    }
  });

  it("strict-object: rejects unknown keys (e.g. client serviceDate)", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient();
    const res = await handleCreateCaseNote(
      caseNoteReq(token, { ...VALID_BODY, serviceDate: "2026-01-01" }),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    expect(res.status).toBe(422);
  });
});

describe("handleCreateCaseNote — authz scope", () => {
  it("SPECIALIST + own PE → 201", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient({ ownerId: SPECIALIST_ID });
    const res = await handleCreateCaseNote(
      caseNoteReq(token, VALID_BODY),
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
    const res = await handleCreateCaseNote(
      caseNoteReq(token, VALID_BODY),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    expect(res.status).toBe(403);
    expect(createRecordFn).not.toHaveBeenCalled();
  });

  it("VP + any PE → 201", async () => {
    const { store, seed } = makeStore();
    const token = seed("VP");
    const { client } = makeRestClient({ ownerId: OTHER_SPECIALIST_ID });
    const res = await handleCreateCaseNote(
      caseNoteReq(token, VALID_BODY),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    expect(res.status).toBe(201);
  });

  it("SUPERVISOR → 403; SYSTEM_ADMIN → 403", async () => {
    const { store, seed } = makeStore();
    for (const [role, reason] of [
      ["SUPERVISOR", "supervisor_scope_unmapped"],
      ["SYSTEM_ADMIN", "role_not_permitted"],
    ] as const) {
      const token = seed(role);
      const { client } = makeRestClient();
      const res = await handleCreateCaseNote(
        caseNoteReq(token, VALID_BODY),
        routeCtx(),
        baseOptions(store, { restClient: client }),
      );
      expect(res.status).toBe(403);
      const body = (await res.json()) as { details?: { reason?: string } };
      expect(body.details?.reason).toBe(reason);
    }
  });

  it("404 when the PE is unknown", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client, createRecordFn } = makeRestClient({ peNotFound: true });
    const res = await handleCreateCaseNote(
      caseNoteReq(token, VALID_BODY),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    expect(res.status).toBe(404);
    expect(createRecordFn).not.toHaveBeenCalled();
  });
});

describe("handleCreateCaseNote — happy path", () => {
  it("writes the full IDW_Case_Note__c payload incl. the direct PE link", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client, createRecordFn } = makeRestClient();
    await handleCreateCaseNote(
      caseNoteReq(token, {
        note: "Home visit went well",
        contactType: "In Person",
        type: "Stability Meeting",
        status: "Completed",
      }),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    expect(createRecordFn).toHaveBeenCalledTimes(1);
    const [sobject, payload] = createRecordFn.mock.calls[0]!;
    expect(sobject).toBe("IDW_Case_Note__c");
    expect(payload).toEqual({
      Program_Enrollment__c: PARTICIPANT_ID,
      Case_Note__c: "Home visit went well",
      Service_Date__c: NOW_DATE,
      Contact_Type__c: "In Person",
      Type__c: "Stability Meeting",
      Status__c: "Completed",
    });
  });

  it("response echoes the case-note fields incl. the note", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient({
      createResult: { id: "a1dE2E0CASExQAO1", success: true, errors: [] },
    });
    const res = await handleCreateCaseNote(
      caseNoteReq(token, VALID_BODY),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      caseNoteId: "a1dE2E0CASExQAO1",
      participantId: PARTICIPANT_ID,
      note: VALID_BODY.note,
      contactType: "Phone",
      type: "Check In",
      status: "Completed",
      serviceDate: NOW_DATE,
      loggedBy: SPECIALIST_ID,
      loggedAt: NOW.toISOString(),
    });
  });

  it("SUCCESS audit metadata carries {source, contact_type, activity_type, status} — never the note", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient();
    const capture = makeAuditCapture();
    const res = await handleCreateCaseNote(
      caseNoteReq(token, {
        note: "sensitive case detail here",
        contactType: "Email",
        type: "Other",
        status: "Attempted",
      }),
      routeCtx(),
      baseOptions(store, { restClient: client, writeAudit: capture.writer }),
    );
    expect(res.status).toBe(201);
    expect(capture.audits).toHaveLength(1);
    expect(capture.audits[0]).toMatchObject({
      actionType: "case_note.created",
      outcome: "SUCCESS",
      participantId: PARTICIPANT_ID,
      salesforceRecordId: "a1dE2E0NEWxQAO12",
    });
    const metadata = capture.audits[0]!.payloadMetadata!;
    expect(metadata).toEqual({
      source: "tool",
      contact_type: "Email",
      activity_type: "Other",
      status: "Attempted",
    });
    expect(JSON.stringify(metadata)).not.toContain("sensitive case detail");
    expect(Object.keys(metadata).some((k) => k.includes("note"))).toBe(false);
  });
});

describe("handleCreateCaseNote — Salesforce failures + idempotency", () => {
  it("SF_VALIDATION_FAILED on createRecord → 422 + FAILED audit (failure_phase=create)", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient({
      createError: new SalesforceError("SF_VALIDATION_FAILED", "BAD", 400),
    });
    const capture = makeAuditCapture();
    const res = await handleCreateCaseNote(
      caseNoteReq(token, VALID_BODY),
      routeCtx(),
      baseOptions(store, { restClient: client, writeAudit: capture.writer }),
    );
    expect(res.status).toBe(422);
    expect(capture.audits[0]).toMatchObject({
      actionType: "case_note.created",
      outcome: "FAILED",
    });
    expect(capture.audits[0]?.payloadMetadata).toMatchObject({
      failure_phase: "create",
      sf_code: "SF_VALIDATION_FAILED",
    });
  });

  it("SF outage during authz-lookup → 503 + FAILED (failure_phase=authz_lookup)", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client, createRecordFn } = makeRestClient({
      queryError: new SalesforceError("SF_NETWORK_TIMEOUT", "timed out"),
    });
    const capture = makeAuditCapture();
    const res = await handleCreateCaseNote(
      caseNoteReq(token, VALID_BODY),
      routeCtx(),
      baseOptions(store, { restClient: client, writeAudit: capture.writer }),
    );
    expect(res.status).toBe(503);
    expect(capture.audits[0]?.payloadMetadata).toMatchObject({
      failure_phase: "authz_lookup",
    });
    expect(createRecordFn).not.toHaveBeenCalled();
  });

  it("replay with the same key returns the cached response, one audit row", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client, createRecordFn } = makeRestClient();
    const capture = makeAuditCapture();
    const opts = baseOptions(store, {
      restClient: client,
      idempotencyStore: makeIdemStore(),
      writeAudit: capture.writer,
    });
    const res1 = await handleCreateCaseNote(caseNoteReq(token, VALID_BODY, IDEM_KEY), routeCtx(), opts);
    const res2 = await handleCreateCaseNote(caseNoteReq(token, VALID_BODY, IDEM_KEY), routeCtx(), opts);
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
    await handleCreateCaseNote(caseNoteReq(token, VALID_BODY, IDEM_KEY), routeCtx(), opts);
    await handleCreateCaseNote(caseNoteReq(token, VALID_BODY, IDEM_KEY_B), routeCtx(), opts);
    expect(createRecordFn).toHaveBeenCalledTimes(2);
  });

  it("500 INTERNAL_ERROR when the SUCCESS audit write throws", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient();
    const failingWriter: NonNullable<CreateCaseNoteHandlerOptions["writeAudit"]> =
      vi.fn(() => Promise.reject(new Error("audit-write-failed")));
    const res = await handleCreateCaseNote(
      caseNoteReq(token, VALID_BODY),
      routeCtx(),
      baseOptions(store, { restClient: client, writeAudit: failingWriter }),
    );
    expect(res.status).toBe(500);
  });
});

describe("handleCreateCaseNote — Pattern B PII firewall (real writer)", () => {
  it("the real assertNoPii does not throw on the case_note.created metadata shape", async () => {
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

    const res = await handleCreateCaseNote(
      caseNoteReq(token, { ...VALID_BODY, note: "free-text case note body" }),
      routeCtx(),
      baseOptions(store, {
        restClient: client,
        db: fakeDb,
        writeAudit: writeAuditEntry,
      }),
    );
    expect(res.status).toBe(201);
    expect(insertedRows).toHaveLength(1);
    expect(JSON.stringify(insertedRows[0])).not.toContain("free-text case note body");
  });
});
