import { hashToken, loadSessionConfig, mintToken } from "@anthos/auth";
import type { Role } from "@anthos/auth";
import { getCalibrationConfiguration } from "@anthos/domain";
import {
  SalesforceError,
  type SalesforceAuth,
  type SoqlQueryResponse,
} from "@anthos/integrations";
import type { DbOrTx } from "@anthos/persistence";
import { describe, expect, it, vi } from "vitest";

import { handleSendSms } from "../../../src/comms/sms/create-sms.js";
import type { SendSmsHandlerOptions } from "../../../src/comms/sms/create-sms.js";
import type {
  IdempotencyRecord,
  IdempotencyStatus,
  IdempotencyStore,
} from "../../../src/idempotency/store.js";
import type { ScoreCaseloadResult } from "../../../src/caseload/score-caseload.js";
import type { SessionRecord, SessionStore } from "../../../src/session/store.js";
import { makeEngineOutput, makeScored } from "../../caseload/_fixtures.js";
import { makeSnapshot } from "../../calibration/_fixtures.js";

// ── constants ─────────────────────────────────────────────────────────────
const SESSION_CONFIG = loadSessionConfig({});
const HOUR = 60 * 60 * 1000;
const SPECIALIST_ID = "0058K00000XYZAbQAO";
const PARTICIPANT_ID = "a1kU800000pjn4WIAQ";
const CONTACT_ID = "0035g00000ABCDxQAO";
const IDEM_KEY = "11111111-1111-4111-8111-111111111111";
const PHONE = "+12125550123";
// NYC 11:30 EDT — outside quiet hours.
const NOW_OUTSIDE = new Date("2026-05-22T15:30:00Z");
// NYC 23:00 EDT — inside quiet hours; next-allowed 08:00 EDT == 12:00Z.
const NOW_INSIDE = new Date("2026-05-22T03:00:00Z");
const CONFIG = getCalibrationConfiguration();
const FAKE_DB = {} as unknown as DbOrTx;
const DEFAULT_SMS_ID = "a40U80000021uF7IAI";

// ── session store ───────────────────────────────────────────────────────────
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

// ── idempotency store ─────────────────────────────────────────────────────
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

// ── rest client (authz + recipient lookup) ──────────────────────────────────
interface PeRow {
  Aftercare_Owner__c: string | null;
  Contact__c: string | null;
  Contact__r: {
    Mogli_Phone_Number__c: string | null;
    Mogli_SMS__Mogli_Opt_Out__c: boolean | null;
  } | null;
}

function makeRestClient(
  opts: {
    ownerId?: string | null;
    recordNotFound?: boolean;
    queryError?: SalesforceError;
    phone?: string | null;
    contactId?: string | null;
    optedOut?: boolean;
  } = {},
) {
  const queryFn = vi.fn(async (_soql: string) => {
    if (opts.queryError !== undefined) throw opts.queryError;
    if (opts.recordNotFound) {
      return { totalSize: 0, done: true, records: [] } as SoqlQueryResponse<PeRow>;
    }
    return {
      totalSize: 1,
      done: true,
      records: [
        {
          Aftercare_Owner__c: opts.ownerId ?? SPECIALIST_ID,
          Contact__c: opts.contactId === undefined ? CONTACT_ID : opts.contactId,
          Contact__r: {
            Mogli_Phone_Number__c: opts.phone === undefined ? PHONE : opts.phone,
            Mogli_SMS__Mogli_Opt_Out__c: opts.optedOut ?? false,
          },
        },
      ],
    } as SoqlQueryResponse<PeRow>;
  });
  const client = { query: queryFn } as unknown as import("@anthos/integrations").SalesforceRestClient;
  return { client, queryFn };
}

// ── mogli client seam ────────────────────────────────────────────────────────
function makeMogli(opts: { sendError?: SalesforceError; smsId?: string } = {}) {
  const sendSms = vi.fn(async (args: { scheduledDelivery?: string }) => {
    if (opts.sendError !== undefined) throw opts.sendError;
    return {
      smsId: opts.smsId ?? DEFAULT_SMS_ID,
      mogliMessageId: opts.smsId ?? DEFAULT_SMS_ID,
      deliveryStatus: args.scheduledDelivery !== undefined ? "scheduled" : "queued",
    } as const;
  });
  return {
    mogli: { sendSms } as unknown as import("@anthos/integrations").MogliClient,
    sendSms,
  };
}

const FAKE_AUTH: SalesforceAuth = {
  getAccessToken: () => Promise.resolve("test-token"),
  getInstanceUrl: () => Promise.resolve("https://test.my.salesforce.com"),
};

function makeScoreCaseload(): NonNullable<SendSmsHandlerOptions["scoreCaseloadImpl"]> {
  return vi.fn(
    () =>
      Promise.resolve({
        scored: [
          makeScored(
            makeSnapshot(PARTICIPANT_ID, SPECIALIST_ID),
            makeEngineOutput(PARTICIPANT_ID, { priorityScore: 81, tier: 1 }),
          ),
        ],
        roundTrips: 2,
        hydratedAt: NOW_OUTSIDE,
        configuration: CONFIG,
        now: NOW_OUTSIDE,
      }) as Promise<ScoreCaseloadResult>,
  );
}

interface AuditCapture {
  audits: Array<{
    actionType: string;
    outcome: string;
    channel?: string;
    salesforceRecordId?: string;
    payloadMetadata?: Record<string, unknown>;
  }>;
  writer: NonNullable<SendSmsHandlerOptions["writeAudit"]>;
}

function makeAuditCapture(): AuditCapture {
  const audits: AuditCapture["audits"] = [];
  const writer: NonNullable<SendSmsHandlerOptions["writeAudit"]> = vi.fn(
    (_db, entry) => {
      audits.push({
        actionType: entry.actionType,
        outcome: entry.outcome,
        ...(entry.channel !== undefined ? { channel: entry.channel } : {}),
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

function smsReq(
  token: string | undefined,
  body: unknown,
  idempotencyKey: string | null = IDEM_KEY,
  participantId: string = PARTICIPANT_ID,
): Request {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (token !== undefined) headers.set("Cookie", `anthos_session=${token}`);
  if (idempotencyKey !== null) headers.set("Idempotency-Key", idempotencyKey);
  return new Request(
    `https://bff.test/api/v1/participants/${participantId}/sms`,
    { method: "POST", headers, body: JSON.stringify(body) },
  );
}

function routeCtx(participantId: string = PARTICIPANT_ID) {
  return { params: Promise.resolve({ id: participantId }) };
}

function baseOptions(
  store: SessionStore,
  overrides: Partial<SendSmsHandlerOptions> = {},
): SendSmsHandlerOptions {
  return {
    store,
    sessionConfig: SESSION_CONFIG,
    idempotencyStore: makeIdemStore(),
    db: FAKE_DB,
    writeAudit: overrides.writeAudit ?? makeAuditCapture().writer,
    salesforceAuth: FAKE_AUTH,
    scoreCaseloadImpl: makeScoreCaseload(),
    now: () => NOW_OUTSIDE,
    ...overrides,
  };
}

// ── tests ─────────────────────────────────────────────────────────────────
describe("handleSendSms (E-11)", () => {
  it("sends an immediate SMS outside quiet hours → 201 + sms.sent audit", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient();
    const { mogli, sendSms } = makeMogli();
    const audit = makeAuditCapture();

    const res = await handleSendSms(
      smsReq(token, { body: "Hi, confirming Tuesday." }),
      routeCtx(),
      baseOptions(store, { restClient: client, mogliClient: mogli, writeAudit: audit.writer }),
    );

    expect(res.status).toBe(201);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.smsId).toBe(DEFAULT_SMS_ID);
    expect(json.deliveryStatus).toBe("queued");
    expect(json.scheduledFor).toBeNull();
    expect(json.consentVerifiedAt).toBeTypeOf("string");

    expect(sendSms).toHaveBeenCalledTimes(1);
    const sendArg = sendSms.mock.calls[0]![0] as Record<string, unknown>;
    expect(sendArg.phoneNumber).toBe(PHONE);
    expect(sendArg.contactId).toBe(CONTACT_ID);
    expect(sendArg.programEnrollmentId).toBe(PARTICIPANT_ID);

    expect(audit.audits).toHaveLength(1);
    expect(audit.audits[0]).toMatchObject({
      actionType: "sms.sent",
      outcome: "SUCCESS",
      channel: "sms",
      salesforceRecordId: DEFAULT_SMS_ID,
    });
  });

  it("PII firewall: audit payload carries no body or phone", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient();
    const { mogli } = makeMogli();
    const audit = makeAuditCapture();

    await handleSendSms(
      smsReq(token, { body: "Sensitive: call me at 212-555-0123", templateKey: "checkin" }),
      routeCtx(),
      baseOptions(store, { restClient: client, mogliClient: mogli, writeAudit: audit.writer }),
    );

    const payload = audit.audits[0]?.payloadMetadata ?? {};
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("212-555-0123");
    expect(serialized).not.toContain("Sensitive");
    expect(payload).not.toHaveProperty("body");
    expect(payload).toMatchObject({
      source: "tool",
      template_key: "checkin",
      delivery_status: "queued",
      scheduled: false,
      consent_verified: true,
    });
  });

  it("blocks an immediate send during quiet hours → 409 with next window", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient();
    const { mogli, sendSms } = makeMogli();
    const audit = makeAuditCapture();

    const res = await handleSendSms(
      smsReq(token, { body: "Late night message" }),
      routeCtx(),
      baseOptions(store, {
        restClient: client,
        mogliClient: mogli,
        writeAudit: audit.writer,
        now: () => NOW_INSIDE,
      }),
    );

    expect(res.status).toBe(409);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.code).toBe("QUIET_HOURS_BLOCKED");
    expect((json.details as Record<string, unknown>).nextAllowedWindowStart).toBe(
      "2026-05-22T12:00:00.000Z",
    );
    // No write, no audit — pre-mutation rejection.
    expect(sendSms).not.toHaveBeenCalled();
    expect(audit.audits).toHaveLength(0);
  });

  it("accepts a scheduled send outside quiet hours → 201 sms.scheduled", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient();
    const { mogli, sendSms } = makeMogli();
    const audit = makeAuditCapture();

    const res = await handleSendSms(
      smsReq(token, {
        body: "Scheduled for the morning",
        scheduledFor: "2026-05-22T12:00:00.000Z",
      }),
      routeCtx(),
      baseOptions(store, {
        restClient: client,
        mogliClient: mogli,
        writeAudit: audit.writer,
        now: () => NOW_INSIDE,
      }),
    );

    expect(res.status).toBe(201);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.deliveryStatus).toBe("scheduled");
    expect(json.scheduledFor).toBe("2026-05-22T12:00:00.000Z");
    expect(sendSms.mock.calls[0]![0]).toMatchObject({
      scheduledDelivery: "2026-05-22T12:00:00.000Z",
    });
    expect(audit.audits[0]).toMatchObject({ actionType: "sms.scheduled" });
  });

  it("rejects a scheduledFor that lands inside quiet hours → 422", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient();
    const { mogli } = makeMogli();

    const res = await handleSendSms(
      // 2026-05-23T02:00Z → 22:00 EDT, inside quiet hours.
      smsReq(token, { body: "x", scheduledFor: "2026-05-23T02:00:00.000Z" }),
      routeCtx(),
      baseOptions(store, { restClient: client, mogliClient: mogli }),
    );

    expect(res.status).toBe(422);
    const json = (await res.json()) as Record<string, unknown>;
    expect((json.details as Record<string, unknown>).reason).toBe("inside_quiet_hours");
  });

  it("refuses a send to an opted-out participant → 403 SMS_CONSENT_WITHHELD", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient({ optedOut: true });
    const { mogli, sendSms } = makeMogli();

    const res = await handleSendSms(
      smsReq(token, { body: "Hi" }),
      routeCtx(),
      baseOptions(store, { restClient: client, mogliClient: mogli }),
    );

    expect(res.status).toBe(403);
    expect(((await res.json()) as Record<string, unknown>).code).toBe(
      "SMS_CONSENT_WITHHELD",
    );
    expect(sendSms).not.toHaveBeenCalled();
  });

  it("returns 422 NO_PHONE_ON_FILE when the contact has no Mogli phone", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient({ phone: null });
    const { mogli } = makeMogli();

    const res = await handleSendSms(
      smsReq(token, { body: "Hi" }),
      routeCtx(),
      baseOptions(store, { restClient: client, mogliClient: mogli }),
    );

    expect(res.status).toBe(422);
    expect(((await res.json()) as Record<string, unknown>).code).toBe("NO_PHONE_ON_FILE");
  });

  it("blocks a SPECIALIST from texting outside their caseload → 403", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient({ ownerId: "0058K00000OTHERxQAO" });
    const { mogli, sendSms } = makeMogli();

    const res = await handleSendSms(
      smsReq(token, { body: "Hi" }),
      routeCtx(),
      baseOptions(store, { restClient: client, mogliClient: mogli }),
    );

    expect(res.status).toBe(403);
    expect(((await res.json()) as Record<string, unknown>).code).toBe("NOT_IN_OWN_CASELOAD");
    expect(sendSms).not.toHaveBeenCalled();
  });

  it("requires an Idempotency-Key → 400", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient();
    const { mogli } = makeMogli();

    const res = await handleSendSms(
      smsReq(token, { body: "Hi" }, null),
      routeCtx(),
      baseOptions(store, { restClient: client, mogliClient: mogli }),
    );
    expect(res.status).toBe(400);
  });

  it("replays the cached response on a duplicate Idempotency-Key", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient();
    const { mogli, sendSms } = makeMogli();
    const idempotencyStore = makeIdemStore();
    const opts = baseOptions(store, {
      restClient: client,
      mogliClient: mogli,
      idempotencyStore,
    });

    const first = await handleSendSms(smsReq(token, { body: "Hi" }), routeCtx(), opts);
    expect(first.status).toBe(201);
    const second = await handleSendSms(smsReq(token, { body: "Hi" }), routeCtx(), opts);
    expect(second.status).toBe(201);
    // Handler ran exactly once — the second call replayed the cache.
    expect(sendSms).toHaveBeenCalledTimes(1);
  });

  it("writes a FAILED audit and maps the error when the Mogli insert fails", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient();
    const { mogli } = makeMogli({
      sendError: new SalesforceError("SF_VALIDATION_FAILED", "bad picklist"),
    });
    const audit = makeAuditCapture();

    const res = await handleSendSms(
      smsReq(token, { body: "Hi" }),
      routeCtx(),
      baseOptions(store, { restClient: client, mogliClient: mogli, writeAudit: audit.writer }),
    );

    expect(res.status).toBe(422);
    expect(audit.audits).toHaveLength(1);
    expect(audit.audits[0]).toMatchObject({
      actionType: "sms.sent",
      outcome: "FAILED",
      channel: "sms",
    });
  });

  it("returns 404 when the participant is not found", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient({ recordNotFound: true });
    const { mogli } = makeMogli();

    const res = await handleSendSms(
      smsReq(token, { body: "Hi" }),
      routeCtx(),
      baseOptions(store, { restClient: client, mogliClient: mogli }),
    );
    expect(res.status).toBe(404);
  });
});
