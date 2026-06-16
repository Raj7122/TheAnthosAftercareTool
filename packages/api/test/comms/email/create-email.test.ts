import { hashToken, loadSessionConfig, mintToken } from "@anthos/auth";
import type { Role } from "@anthos/auth";
import {
  SalesforceError,
  type SalesforceAuth,
  type SoqlQueryResponse,
} from "@anthos/integrations";
import type { DbOrTx } from "@anthos/persistence";
import { describe, expect, it, vi } from "vitest";

import { handleSendEmail } from "../../../src/comms/email/create-email.js";
import type { SendEmailHandlerOptions } from "../../../src/comms/email/create-email.js";
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
const IDEM_KEY = "11111111-1111-4111-8111-111111111111";
const FLOW_NAME = "Anthos_Send_Email";
const FAKE_DB = {} as unknown as DbOrTx;
const ACTIVITY_ID = "00T5g00000XyzAAA";

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

interface PeRow {
  Aftercare_Owner__c: string | null;
  Contact__c: string | null;
  Contact__r: { Email: string | null; HasOptedOutOfEmail: boolean | null } | null;
}

function makeRestClient(
  opts: {
    ownerId?: string | null;
    recordNotFound?: boolean;
    email?: string | null;
    optedOut?: boolean;
  } = {},
) {
  const queryFn = vi.fn(async (_soql: string) => {
    if (opts.recordNotFound) {
      return { totalSize: 0, done: true, records: [] } as SoqlQueryResponse<PeRow>;
    }
    return {
      totalSize: 1,
      done: true,
      records: [
        {
          Aftercare_Owner__c: opts.ownerId ?? SPECIALIST_ID,
          Contact__c: "0035g00000ABCDxQAO",
          Contact__r: {
            Email: opts.email === undefined ? "p@example.org" : opts.email,
            HasOptedOutOfEmail: opts.optedOut ?? false,
          },
        },
      ],
    } as SoqlQueryResponse<PeRow>;
  });
  const client = { query: queryFn } as unknown as import("@anthos/integrations").SalesforceRestClient;
  return { client, queryFn };
}

function makeEmailClient(opts: { sendError?: SalesforceError } = {}) {
  const send = vi.fn(async () => {
    if (opts.sendError !== undefined) throw opts.sendError;
    return { emailId: ACTIVITY_ID, activityId: ACTIVITY_ID };
  });
  return {
    email: { send } as unknown as import("@anthos/integrations").EmailFlowClient,
    send,
  };
}

const FAKE_AUTH: SalesforceAuth = {
  getAccessToken: () => Promise.resolve("test-token"),
  getInstanceUrl: () => Promise.resolve("https://test.my.salesforce.com"),
};

interface AuditCapture {
  audits: Array<{
    actionType: string;
    outcome: string;
    channel?: string;
    salesforceRecordId?: string;
    payloadMetadata?: Record<string, unknown>;
  }>;
  writer: NonNullable<SendEmailHandlerOptions["writeAudit"]>;
}

function makeAuditCapture(): AuditCapture {
  const audits: AuditCapture["audits"] = [];
  const writer: NonNullable<SendEmailHandlerOptions["writeAudit"]> = vi.fn(
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

function emailReq(
  token: string | undefined,
  body: unknown,
  idempotencyKey: string | null = IDEM_KEY,
  participantId: string = PARTICIPANT_ID,
): Request {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (token !== undefined) headers.set("Cookie", `anthos_session=${token}`);
  if (idempotencyKey !== null) headers.set("Idempotency-Key", idempotencyKey);
  return new Request(
    `https://bff.test/api/v1/participants/${participantId}/emails`,
    { method: "POST", headers, body: JSON.stringify(body) },
  );
}

function routeCtx(participantId: string = PARTICIPANT_ID) {
  return { params: Promise.resolve({ id: participantId }) };
}

function baseOptions(
  store: SessionStore,
  overrides: Partial<SendEmailHandlerOptions> = {},
): SendEmailHandlerOptions {
  return {
    store,
    sessionConfig: SESSION_CONFIG,
    idempotencyStore: makeIdemStore(),
    db: FAKE_DB,
    writeAudit: overrides.writeAudit ?? makeAuditCapture().writer,
    salesforceAuth: FAKE_AUTH,
    flowApiName: FLOW_NAME,
    ...overrides,
  };
}

const VALID = { subject: "Your visit", body: "<p>Hi</p>" };

describe("handleSendEmail (E-12)", () => {
  it("sends an email via the Flow → 202 + email.sent audit", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient();
    const { email, send } = makeEmailClient();
    const audit = makeAuditCapture();

    const res = await handleSendEmail(
      emailReq(token, { ...VALID, templateKey: "checkin" }),
      routeCtx(),
      baseOptions(store, { restClient: client, emailClient: email, writeAudit: audit.writer }),
    );

    expect(res.status).toBe(202);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.activityId).toBe(ACTIVITY_ID);
    expect(json.consentChecked).toBe(true);
    expect(json.activityReconciliationStatus).toBe("reconciled");
    expect(send).toHaveBeenCalledTimes(1);

    expect(audit.audits).toHaveLength(1);
    expect(audit.audits[0]).toMatchObject({
      actionType: "email.sent",
      outcome: "SUCCESS",
      channel: "email",
      salesforceRecordId: ACTIVITY_ID,
    });
  });

  it("PII firewall: audit payload carries no subject or body", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient();
    const { email } = makeEmailClient();
    const audit = makeAuditCapture();

    await handleSendEmail(
      emailReq(token, { subject: "Sensitive subject", body: "<p>secret body</p>", templateKey: "voucher" }),
      routeCtx(),
      baseOptions(store, { restClient: client, emailClient: email, writeAudit: audit.writer }),
    );

    const payload = audit.audits[0]?.payloadMetadata ?? {};
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("Sensitive");
    expect(serialized).not.toContain("secret body");
    expect(payload).toMatchObject({ source: "tool", template_key: "voucher", consent_checked: true });
  });

  it("returns 503 EMAIL_NOT_CONFIGURED when no flow is configured", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient();

    const res = await handleSendEmail(emailReq(token, VALID), routeCtx(), {
      store,
      sessionConfig: SESSION_CONFIG,
      idempotencyStore: makeIdemStore(),
      db: FAKE_DB,
      writeAudit: makeAuditCapture().writer,
      salesforceAuth: FAKE_AUTH,
      restClient: client,
      flowApiName: "",
    });

    expect(res.status).toBe(503);
    expect(((await res.json()) as Record<string, unknown>).code).toBe("EMAIL_NOT_CONFIGURED");
  });

  it("refuses an opted-out participant → 403 EMAIL_CONSENT_WITHHELD", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient({ optedOut: true });
    const { email, send } = makeEmailClient();

    const res = await handleSendEmail(
      emailReq(token, VALID),
      routeCtx(),
      baseOptions(store, { restClient: client, emailClient: email }),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as Record<string, unknown>).code).toBe("EMAIL_CONSENT_WITHHELD");
    expect(send).not.toHaveBeenCalled();
  });

  it("returns 422 NO_EMAIL_ON_FILE when the contact has no email", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient({ email: null });
    const { email } = makeEmailClient();

    const res = await handleSendEmail(
      emailReq(token, VALID),
      routeCtx(),
      baseOptions(store, { restClient: client, emailClient: email }),
    );
    expect(res.status).toBe(422);
    expect(((await res.json()) as Record<string, unknown>).code).toBe("NO_EMAIL_ON_FILE");
  });

  it("blocks a SPECIALIST emailing outside their caseload → 403", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient({ ownerId: "0058K00000OTHERxQAO" });
    const { email, send } = makeEmailClient();

    const res = await handleSendEmail(
      emailReq(token, VALID),
      routeCtx(),
      baseOptions(store, { restClient: client, emailClient: email }),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as Record<string, unknown>).code).toBe("NOT_IN_OWN_CASELOAD");
    expect(send).not.toHaveBeenCalled();
  });

  it("replays the cached response on a duplicate Idempotency-Key", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient();
    const { email, send } = makeEmailClient();
    const opts = baseOptions(store, {
      restClient: client,
      emailClient: email,
      idempotencyStore: makeIdemStore(),
    });

    const first = await handleSendEmail(emailReq(token, VALID), routeCtx(), opts);
    expect(first.status).toBe(202);
    const second = await handleSendEmail(emailReq(token, VALID), routeCtx(), opts);
    expect(second.status).toBe(202);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("writes a FAILED audit and maps the error when the Flow invocation fails", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient();
    const { email } = makeEmailClient({
      sendError: new SalesforceError("SF_VALIDATION_FAILED", "flow rejected"),
    });
    const audit = makeAuditCapture();

    const res = await handleSendEmail(
      emailReq(token, VALID),
      routeCtx(),
      baseOptions(store, { restClient: client, emailClient: email, writeAudit: audit.writer }),
    );
    expect(res.status).toBe(422);
    expect(audit.audits[0]).toMatchObject({
      actionType: "email.sent",
      outcome: "FAILED",
      channel: "email",
    });
  });

  it("returns 404 when the participant is not found", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient({ recordNotFound: true });
    const { email } = makeEmailClient();

    const res = await handleSendEmail(
      emailReq(token, VALID),
      routeCtx(),
      baseOptions(store, { restClient: client, emailClient: email }),
    );
    expect(res.status).toBe(404);
  });
});
