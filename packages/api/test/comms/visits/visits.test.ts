import { hashToken, loadSessionConfig, mintToken } from "@anthos/auth";
import type { Role } from "@anthos/auth";
import {
  SalesforceError,
  type SalesforceAuth,
  type SoqlQueryResponse,
} from "@anthos/integrations";
import type { DbOrTx } from "@anthos/persistence";
import { describe, expect, it, vi } from "vitest";

import { handleScheduleVisit } from "../../../src/comms/visits/create-visit.js";
import { handleProposeTimes } from "../../../src/comms/visits/propose-times.js";
import { handleLogVisit } from "../../../src/comms/visits/log-visit.js";
import type {
  IdempotencyRecord,
  IdempotencyStatus,
  IdempotencyStore,
} from "../../../src/idempotency/store.js";
import type { SessionRecord, SessionStore } from "../../../src/session/store.js";

const SESSION_CONFIG = loadSessionConfig({});
const HOUR = 60 * 60 * 1000;
const SPECIALIST_ID = "0058K00000XYZAbQAO";
const PARTICIPANT_ID = "a1kU800000pjn4WIAQ";
const VISIT_ID = "a0C5g00000Vis1tAAO";
const SURVEY_ID = "a0D5g00000Srvy1AAO";
const IDEM_KEY = "11111111-1111-4111-8111-111111111111";
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
      if (row) { row.status = "COMPLETED"; row.responseStatusCode = code; row.responseBody = body; }
      return Promise.resolve();
    },
    markFailedTerminal(key, code, body) {
      const row = rows.get(key);
      if (row) { row.status = "FAILED_TERMINAL"; row.responseStatusCode = code; row.responseBody = body; }
      return Promise.resolve();
    },
    delete(key) { rows.delete(key); return Promise.resolve(); },
    cleanupExpired() { return Promise.resolve(0); },
  };
}

const FAKE_AUTH: SalesforceAuth = {
  getAccessToken: () => Promise.resolve("test-token"),
  getInstanceUrl: () => Promise.resolve("https://test.my.salesforce.com"),
};

interface AuditEntry {
  actionType: string;
  outcome: string;
  channel?: string;
  salesforceRecordId?: string;
  payloadMetadata?: Record<string, unknown>;
}

function makeAuditCapture() {
  const audits: AuditEntry[] = [];
  const writer = vi.fn((_db: unknown, entry: AuditEntry) => {
    audits.push({
      actionType: entry.actionType,
      outcome: entry.outcome,
      ...(entry.channel !== undefined ? { channel: entry.channel } : {}),
      ...(entry.salesforceRecordId !== undefined ? { salesforceRecordId: entry.salesforceRecordId } : {}),
      ...(entry.payloadMetadata !== undefined ? { payloadMetadata: entry.payloadMetadata } : {}),
    });
    return Promise.resolve({ id: `audit-${audits.length}` });
  });
  return { audits, writer: writer as never };
}

// A flexible rest-client double: `query` returns a configurable record set;
// `createRecord` / `updateRecord` are spies with configurable results.
function makeRestClient(opts: {
  queryRecords?: unknown[];
  queryError?: SalesforceError;
  createId?: string;
  createError?: SalesforceError;
} = {}) {
  const query = vi.fn(async (_soql: string) => {
    if (opts.queryError !== undefined) throw opts.queryError;
    const records = opts.queryRecords ?? [];
    return { totalSize: records.length, done: true, records } as SoqlQueryResponse<unknown>;
  });
  const createRecord = vi.fn(async (_sobject: string, _fields: unknown) => {
    if (opts.createError !== undefined) throw opts.createError;
    return { id: opts.createId ?? VISIT_ID, success: true, errors: [] };
  });
  const updateRecord = vi.fn(async () => undefined);
  const client = { query, createRecord, updateRecord } as unknown as import("@anthos/integrations").SalesforceRestClient;
  return { client, query, createRecord, updateRecord };
}

function req(
  token: string | undefined,
  path: string,
  body: unknown,
  idem: string | null = IDEM_KEY,
): Request {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (token !== undefined) headers.set("Cookie", `anthos_session=${token}`);
  if (idem !== null) headers.set("Idempotency-Key", idem);
  return new Request(`https://bff.test${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}

// ── E-13 schedule ───────────────────────────────────────────────────────────
describe("handleScheduleVisit (E-13)", () => {
  const ownerRecord = [{ Aftercare_Owner__c: SPECIALIST_ID }];

  it("writes a Stability Meeting Case Note (Status=Scheduled), Outlook degraded, audits", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client, createRecord } = makeRestClient({ queryRecords: ownerRecord, createId: VISIT_ID });
    const audit = makeAuditCapture();

    const res = await handleScheduleVisit(
      req(token, `/api/v1/participants/${PARTICIPANT_ID}/visits`, {
        scheduledDateTime: "2026-06-15T18:00:00.000Z",
        notes: "Quarterly stability check",
      }),
      { params: Promise.resolve({ id: PARTICIPANT_ID }) },
      {
        store, sessionConfig: SESSION_CONFIG, idempotencyStore: makeIdemStore(),
        db: FAKE_DB, writeAudit: audit.writer, salesforceAuth: FAKE_AUTH,
        restClient: client, graphClient: null, now: () => new Date("2026-06-01T12:00:00Z"),
      },
    );

    expect(res.status).toBe(201);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.visitId).toBe(VISIT_ID);
    expect(json.outlookEventId).toBeNull();
    expect(json.outlookDegraded).toBe(true);
    expect(json.statusLabel).toBe("Scheduled");

    const [sobject, fields] = createRecord.mock.calls[0]! as [string, Record<string, unknown>];
    expect(sobject).toBe("IDW_Case_Note__c");
    expect(fields).toMatchObject({
      Program_Enrollment__c: PARTICIPANT_ID,
      Type__c: "Stability Meeting",
      Status__c: "Scheduled",
      Service_Date__c: "2026-06-15",
      Contact_Type__c: "In Person",
    });
    expect(audit.audits[0]).toMatchObject({
      actionType: "visit.scheduled",
      outcome: "SUCCESS",
      channel: "in_person",
      salesforceRecordId: VISIT_ID,
    });
  });

  it("blocks a SPECIALIST scheduling outside their caseload → 403", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client, createRecord } = makeRestClient({ queryRecords: [{ Aftercare_Owner__c: "0058K00000OTHERxQAO" }] });

    const res = await handleScheduleVisit(
      req(token, `/api/v1/participants/${PARTICIPANT_ID}/visits`, { scheduledDateTime: "2026-06-15T18:00:00.000Z" }),
      { params: Promise.resolve({ id: PARTICIPANT_ID }) },
      { store, sessionConfig: SESSION_CONFIG, idempotencyStore: makeIdemStore(), db: FAKE_DB, writeAudit: makeAuditCapture().writer, salesforceAuth: FAKE_AUTH, restClient: client, graphClient: null },
    );
    expect(res.status).toBe(403);
    expect(createRecord).not.toHaveBeenCalled();
  });
});

// ── E-38 propose-times ────────────────────────────────────────────────────────
describe("handleProposeTimes (E-38)", () => {
  function proposeBody(overrides: Record<string, unknown> = {}) {
    return {
      weekStarting: "2026-06-15", // Monday
      // Mon/Wed/Fri mid-morning windows (all outside 9pm-8am).
      preferredWindowsLocal: [
        { dayOfWeek: 1, startTime: "10:00", endTime: "12:00" },
        { dayOfWeek: 3, startTime: "10:00", endTime: "12:00" },
        { dayOfWeek: 5, startTime: "10:00", endTime: "12:00" },
      ],
      estimatedDurationMinutes: 30,
      participantTimezone: "America/New_York",
      ...overrides,
    };
  }

  it("returns up to 3 ranked, quiet-hours-safe slots with fallbackUsed=true", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient({ queryRecords: [{ Aftercare_Owner__c: SPECIALIST_ID }] });

    const res = await handleProposeTimes(
      req(token, `/api/v1/participants/${PARTICIPANT_ID}/visits/propose-times`, proposeBody()),
      { params: Promise.resolve({ id: PARTICIPANT_ID }) },
      { store, sessionConfig: SESSION_CONFIG, idempotencyStore: makeIdemStore(), salesforceAuth: FAKE_AUTH, restClient: client },
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.fallbackUsed).toBe(true);
    const slots = json.proposedSlots as Array<{ slotStart: string; rank: number }>;
    expect(slots).toHaveLength(3);
    expect(slots.map((s) => s.rank)).toEqual([1, 2, 3]);
    // Chronological order.
    expect(slots[0]!.slotStart < slots[1]!.slotStart).toBe(true);
    // 10:00 EDT == 14:00Z — never inside 9pm-8am.
    expect(slots[0]!.slotStart).toContain("T14:00:00");
  });

  it("returns a typed insufficientReason when no window is feasible", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient({ queryRecords: [{ Aftercare_Owner__c: SPECIALIST_ID }] });

    const res = await handleProposeTimes(
      req(token, `/api/v1/participants/${PARTICIPANT_ID}/visits/propose-times`,
        // 23:00-23:30 local is inside quiet hours → screened out.
        proposeBody({ preferredWindowsLocal: [{ dayOfWeek: 1, startTime: "23:00", endTime: "23:30" }] })),
      { params: Promise.resolve({ id: PARTICIPANT_ID }) },
      { store, sessionConfig: SESSION_CONFIG, idempotencyStore: makeIdemStore(), salesforceAuth: FAKE_AUTH, restClient: client },
    );
    const json = (await res.json()) as Record<string, unknown>;
    expect((json.proposedSlots as unknown[]).length).toBe(0);
    expect(json.insufficientReason).toBe("no_availability_in_windows");
  });
});

// ── P3A-03 log ────────────────────────────────────────────────────────────────
describe("handleLogVisit (P3A-03)", () => {
  function visitRow(aftercareStart: string | null) {
    return [{
      Type__c: "Stability Meeting",
      Program_Enrollment__c: PARTICIPANT_ID,
      Program_Enrollment__r: {
        Aftercare_Owner__c: SPECIALIST_ID,
        Aftercare_Start_Date__c: aftercareStart,
      },
    }];
  }

  it("flips the visit to Completed, creates a Survey, credits the nearest checkpoint", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    // start 2026-03-01, visit occurs 2026-06-10 → ~101 days → credits 90.
    const { client, updateRecord, createRecord } = makeRestClient({
      queryRecords: visitRow("2026-03-01"),
      createId: SURVEY_ID,
    });
    const audit = makeAuditCapture();

    const res = await handleLogVisit(
      req(token, `/api/v1/participants/${PARTICIPANT_ID}/visits/${VISIT_ID}/log`, {
        occurredAt: "2026-06-10T16:00:00.000Z",
        summary: "Visit completed; stable.",
      }),
      { params: Promise.resolve({ id: PARTICIPANT_ID, visitId: VISIT_ID }) },
      { store, sessionConfig: SESSION_CONFIG, idempotencyStore: makeIdemStore(), db: FAKE_DB, writeAudit: audit.writer, salesforceAuth: FAKE_AUTH, restClient: client, now: () => new Date("2026-06-10T16:00:00Z") },
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.status).toBe("Completed");
    expect(json.surveyId).toBe(SURVEY_ID);
    expect(json.checkpointCredited).toBe(90);

    const [sobject, recId, fields] = updateRecord.mock.calls[0]! as [string, string, Record<string, unknown>];
    expect(sobject).toBe("IDW_Case_Note__c");
    expect(recId).toBe(VISIT_ID);
    expect(fields).toMatchObject({ Status__c: "Completed", Service_Date__c: "2026-06-10" });
    expect(createRecord.mock.calls[0]![0]).toBe("Survey__c");
    expect(audit.audits[0]).toMatchObject({ actionType: "visit.logged", outcome: "SUCCESS", channel: "in_person" });
    expect(audit.audits[0]!.payloadMetadata).toMatchObject({ credited: true, credit_anchor: 90 });
  });

  it("does not credit a visit before the first checkpoint (held)", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    // start 2026-05-20, visit 2026-06-10 → ~21 days → < 90 → null.
    const { client } = makeRestClient({ queryRecords: visitRow("2026-05-20"), createId: SURVEY_ID });

    const res = await handleLogVisit(
      req(token, `/api/v1/participants/${PARTICIPANT_ID}/visits/${VISIT_ID}/log`, { occurredAt: "2026-06-10T16:00:00.000Z" }),
      { params: Promise.resolve({ id: PARTICIPANT_ID, visitId: VISIT_ID }) },
      { store, sessionConfig: SESSION_CONFIG, idempotencyStore: makeIdemStore(), db: FAKE_DB, writeAudit: makeAuditCapture().writer, salesforceAuth: FAKE_AUTH, restClient: client, now: () => new Date("2026-06-10T16:00:00Z") },
    );
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.checkpointCredited).toBeNull();
  });

  it("returns 404 when the visit id is not a Stability Meeting on this participant", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient({ queryRecords: [] });

    const res = await handleLogVisit(
      req(token, `/api/v1/participants/${PARTICIPANT_ID}/visits/${VISIT_ID}/log`, {}),
      { params: Promise.resolve({ id: PARTICIPANT_ID, visitId: VISIT_ID }) },
      { store, sessionConfig: SESSION_CONFIG, idempotencyStore: makeIdemStore(), db: FAKE_DB, writeAudit: makeAuditCapture().writer, salesforceAuth: FAKE_AUTH, restClient: client },
    );
    expect(res.status).toBe(404);
  });
});
