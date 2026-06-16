import { hashToken, loadSessionConfig, mintToken } from "@anthos/auth";
import type { Role } from "@anthos/auth";
import {
  SalesforceError,
  type SalesforceAuth,
  type SoqlQueryResponse,
} from "@anthos/integrations";
import type { DbOrTx } from "@anthos/persistence";
import { describe, expect, it, vi } from "vitest";

import { handleGetCaseNotes } from "../../src/participants/get-case-notes.js";
import type {
  CaseNotesQueryFn,
  CaseNotesQueryResult,
  GetCaseNotesHandlerOptions,
} from "../../src/participants/get-case-notes.js";
import {
  decodeCursor,
  encodeCursor,
  generateCursorSigningKeyForTests,
} from "../../src/participants/cursor.js";
import type { SessionRecord, SessionStore } from "../../src/session/store.js";

// ── fixtures ────────────────────────────────────────────────────────────────

const SESSION_CONFIG = loadSessionConfig({});
const HOUR = 60 * 60 * 1000;
const SPECIALIST_ID = "0058K00000XYZAbQAO";
const OTHER_SPECIALIST_ID = "0058K00000QQQXXxQAO";
const PARTICIPANT_ID = "a015g00000ABCDxQAO";
const NOW = new Date("2026-05-24T15:30:00Z");
const FAKE_DB = {} as unknown as DbOrTx;
const SIGNING_KEY = generateCursorSigningKeyForTests();

const FAKE_AUTH: SalesforceAuth = {
  getAccessToken: () => Promise.resolve("test-token"),
  getInstanceUrl: () => Promise.resolve("https://test.my.salesforce.com"),
};

interface IdentityRecord {
  Id: string;
  Name: string | null;
  Aftercare_Owner__c: string | null;
  Full_Name__c: string | null;
  Phone_Number__c: string | null;
  Primary_Contact_s_Email__c: string | null;
  Aftercare_Start_Date__c: string | null;
  Program_Enrollment_Outcome__c: string | null;
  Most_Recent_Case_Note__c: string | null;
  Most_Recent_Case_Note_Status__c: string | null;
  Most_Recent_Case_Note_Type__c: string | null;
  Most_Recent_Case_Note_Text__c: string | null;
}

interface MakeIdentityOpts {
  ownerId?: string | null;
  notFound?: boolean;
  queryError?: SalesforceError;
}

function makeIdentityRecord(opts: MakeIdentityOpts = {}): IdentityRecord {
  return {
    Id: PARTICIPANT_ID,
    Name: "PE-10/2024",
    Aftercare_Owner__c:
      opts.ownerId === undefined ? SPECIALIST_ID : opts.ownerId,
    Full_Name__c: "Mileena Lesane",
    Phone_Number__c: "+12125555050",
    Primary_Contact_s_Email__c: "mileena@example.test",
    Aftercare_Start_Date__c: "2024-10-15",
    Program_Enrollment_Outcome__c: null,
    Most_Recent_Case_Note__c: null,
    Most_Recent_Case_Note_Status__c: null,
    Most_Recent_Case_Note_Type__c: null,
    Most_Recent_Case_Note_Text__c: null,
  };
}

function makeRestClient(opts: MakeIdentityOpts = {}) {
  const queryFn = vi.fn(async (_soql: string) => {
    if (opts.queryError !== undefined) throw opts.queryError;
    if (opts.notFound) {
      return {
        totalSize: 0,
        done: true,
        records: [],
      } as SoqlQueryResponse<IdentityRecord>;
    }
    return {
      totalSize: 1,
      done: true,
      records: [makeIdentityRecord(opts)],
    } as SoqlQueryResponse<IdentityRecord>;
  });
  const client = { query: queryFn } as unknown as
    import("@anthos/integrations").SalesforceRestClient;
  return { client, queryFn };
}

function makeStore(): {
  store: SessionStore;
  seed: (role?: Role, specialistId?: string) => string;
} {
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
  function seed(
    role: Role = "SPECIALIST",
    specialistId: string = SPECIALIST_ID,
  ): string {
    n += 1;
    const token = mintToken();
    rows.set(hashToken(token), {
      id: `session-${n}`,
      specialistId,
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

interface AuditCapture {
  audits: Array<{
    actionType: string;
    outcome: string;
    participantId?: string;
    payloadMetadata?: Record<string, unknown>;
  }>;
  writer: NonNullable<GetCaseNotesHandlerOptions["writeAudit"]>;
}

function makeAuditCapture(): AuditCapture {
  const audits: AuditCapture["audits"] = [];
  const writer: NonNullable<GetCaseNotesHandlerOptions["writeAudit"]> = vi.fn(
    (_db, entry) => {
      audits.push({
        actionType: entry.actionType,
        outcome: entry.outcome,
        ...(entry.participantId !== undefined
          ? { participantId: entry.participantId }
          : {}),
        ...(entry.payloadMetadata !== undefined
          ? {
              payloadMetadata: entry.payloadMetadata as Record<string, unknown>,
            }
          : {}),
      });
      return Promise.resolve({ id: `audit-${audits.length}` });
    },
  );
  return { audits, writer };
}

function caseNotesReq(
  token: string | undefined,
  qs: string = "",
  participantId: string = PARTICIPANT_ID,
): Request {
  const headers = new Headers();
  if (token !== undefined) headers.set("Cookie", `anthos_session=${token}`);
  const url = `https://bff.test/api/v1/participants/${participantId}/case-notes${qs.length > 0 ? `?${qs}` : ""}`;
  return new Request(url, { method: "GET", headers });
}

function routeCtx(participantId: string = PARTICIPANT_ID) {
  return { params: Promise.resolve({ id: participantId }) };
}

// Default SF-query seam — empty page, schema-gap on. Mirrors the production
// stub today; tests override when they need a populated page or an SF error.
const stubQuery: CaseNotesQueryFn = () =>
  Promise.resolve({
    items: [],
    hasMore: false,
    nextCursorSeed: null,
    schemaGap: true,
  });

function baseOptions(
  store: SessionStore,
  overrides: Partial<GetCaseNotesHandlerOptions> = {},
): GetCaseNotesHandlerOptions {
  const audit = overrides.writeAudit ?? makeAuditCapture().writer;
  return {
    store,
    sessionConfig: SESSION_CONFIG,
    db: FAKE_DB,
    writeAudit: audit,
    salesforceAuth: FAKE_AUTH,
    caseNotesQuery: overrides.caseNotesQuery ?? stubQuery,
    cursorSigningKey: SIGNING_KEY,
    now: () => NOW,
    ...overrides,
  };
}

// ── auth gate ───────────────────────────────────────────────────────────────

describe("handleGetCaseNotes — auth gate", () => {
  it("401 AUTH_SESSION_INVALID when no session cookie is present", async () => {
    const { store } = makeStore();
    const { client } = makeRestClient();
    const res = await handleGetCaseNotes(
      caseNotesReq(undefined),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    expect(res.status).toBe(401);
  });
});

// ── path-param validation ───────────────────────────────────────────────────

describe("handleGetCaseNotes — path-param validation", () => {
  it("422 VALIDATION_FAILED for a malformed Salesforce Id", async () => {
    const { store, seed } = makeStore();
    const token = seed();
    const { client } = makeRestClient();
    const res = await handleGetCaseNotes(
      caseNotesReq(token, "", "not-a-sf-id"),
      routeCtx("not-a-sf-id"),
      baseOptions(store, { restClient: client }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string; details?: unknown };
    expect(body.code).toBe("VALIDATION_FAILED");
    expect(body.details).toMatchObject({
      field: "participantId",
      reason: "invalid_salesforce_id",
    });
  });
});

// ── query-param validation ──────────────────────────────────────────────────

describe("handleGetCaseNotes — query params", () => {
  it("400 INVALID_QUERY_PARAM for limit out of range (high)", async () => {
    const { store, seed } = makeStore();
    const token = seed();
    const { client } = makeRestClient();
    const res = await handleGetCaseNotes(
      caseNotesReq(token, "limit=200"),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; details?: unknown };
    expect(body.code).toBe("INVALID_QUERY_PARAM");
    expect(body.details).toMatchObject({ param: "limit" });
  });

  it("400 INVALID_QUERY_PARAM for limit out of range (low)", async () => {
    const { store, seed } = makeStore();
    const token = seed();
    const { client } = makeRestClient();
    const res = await handleGetCaseNotes(
      caseNotesReq(token, "limit=0"),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    expect(res.status).toBe(400);
  });

  it("400 INVALID_QUERY_PARAM for non-integer limit", async () => {
    const { store, seed } = makeStore();
    const token = seed();
    const { client } = makeRestClient();
    const res = await handleGetCaseNotes(
      caseNotesReq(token, "limit=abc"),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    expect(res.status).toBe(400);
  });

  it("400 INVALID_QUERY_PARAM for unknown contactType enum", async () => {
    const { store, seed } = makeStore();
    const token = seed();
    const { client } = makeRestClient();
    const res = await handleGetCaseNotes(
      caseNotesReq(token, "contactType=banana"),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; details?: unknown };
    expect(body.code).toBe("INVALID_QUERY_PARAM");
    expect(body.details).toMatchObject({ param: "contactType" });
  });

  it("admits known contactType values + records the filter flag in audit", async () => {
    const { store, seed } = makeStore();
    const token = seed();
    const { client } = makeRestClient();
    const audit = makeAuditCapture();
    const query = vi.fn(stubQuery);
    const res = await handleGetCaseNotes(
      caseNotesReq(token, "contactType=phone"),
      routeCtx(),
      baseOptions(store, {
        restClient: client,
        writeAudit: audit.writer,
        caseNotesQuery: query,
      }),
    );
    expect(res.status).toBe(200);
    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({ contactType: "phone" }),
    );
    expect(audit.audits[0]?.payloadMetadata).toMatchObject({
      filter_contact_type_present: true,
    });
  });

  it("passes `type` through verbatim (no enum validation per API §7.4.2)", async () => {
    const { store, seed } = makeStore();
    const token = seed();
    const { client } = makeRestClient();
    const audit = makeAuditCapture();
    const query = vi.fn(stubQuery);
    const res = await handleGetCaseNotes(
      caseNotesReq(token, "type=Stability%20Meeting"),
      routeCtx(),
      baseOptions(store, {
        restClient: client,
        writeAudit: audit.writer,
        caseNotesQuery: query,
      }),
    );
    expect(res.status).toBe(200);
    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({ type: "Stability Meeting" }),
    );
    expect(audit.audits[0]?.payloadMetadata).toMatchObject({
      filter_type_present: true,
    });
  });
});

// ── cursor decode ───────────────────────────────────────────────────────────

describe("handleGetCaseNotes — cursor", () => {
  it("400 CURSOR_INVALID on a tampered cursor", async () => {
    const { store, seed } = makeStore();
    const token = seed();
    const { client } = makeRestClient();
    const validCursor = encodeCursor({
      payload: { t: "2026-05-20T00:00:00.000Z", id: "a0M0123456789ABCDE" },
      specialistId: SPECIALIST_ID,
      signingKey: SIGNING_KEY,
    });
    const tampered = `${validCursor.slice(0, -4)}AAAA`;
    const res = await handleGetCaseNotes(
      caseNotesReq(token, `cursor=${encodeURIComponent(tampered)}`),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("CURSOR_INVALID");
  });

  it("400 CURSOR_INVALID when cursor was signed for a different specialist", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST", SPECIALIST_ID);
    const { client } = makeRestClient();
    const foreignCursor = encodeCursor({
      payload: { t: "2026-05-20T00:00:00.000Z", id: "a0M0123456789ABCDE" },
      specialistId: OTHER_SPECIALIST_ID,
      signingKey: SIGNING_KEY,
    });
    const res = await handleGetCaseNotes(
      caseNotesReq(token, `cursor=${encodeURIComponent(foreignCursor)}`),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("CURSOR_INVALID");
  });

  it("400 CURSOR_EXPIRED on a >7d-old cursor", async () => {
    const { store, seed } = makeStore();
    const token = seed();
    const { client } = makeRestClient();
    const oldT = new Date(NOW.getTime() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const stale = encodeCursor({
      payload: { t: oldT, id: "a0M0123456789ABCDE" },
      specialistId: SPECIALIST_ID,
      signingKey: SIGNING_KEY,
    });
    const res = await handleGetCaseNotes(
      caseNotesReq(token, `cursor=${encodeURIComponent(stale)}`),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("CURSOR_EXPIRED");
  });

  it("valid cursor decodes into the SF query args + audit flags cursor_used", async () => {
    const { store, seed } = makeStore();
    const token = seed();
    const { client } = makeRestClient();
    const cursor = encodeCursor({
      payload: { t: "2026-05-22T10:00:00.000Z", id: "a0M0123456789ABCDE" },
      specialistId: SPECIALIST_ID,
      signingKey: SIGNING_KEY,
    });
    const audit = makeAuditCapture();
    const query = vi.fn(stubQuery);
    const res = await handleGetCaseNotes(
      caseNotesReq(token, `cursor=${encodeURIComponent(cursor)}`),
      routeCtx(),
      baseOptions(store, {
        restClient: client,
        writeAudit: audit.writer,
        caseNotesQuery: query,
      }),
    );
    expect(res.status).toBe(200);
    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({
        cursor: { t: "2026-05-22T10:00:00.000Z", id: "a0M0123456789ABCDE" },
      }),
    );
    expect(audit.audits[0]?.payloadMetadata).toMatchObject({ cursor_used: true });
  });
});

describe("cursor codec round-trip", () => {
  it("encode → decode preserves { t, id } for the same specialist", () => {
    const payload = {
      t: "2026-05-22T10:00:00.000Z",
      id: "a0M0123456789ABCDE",
    };
    const token = encodeCursor({
      payload,
      specialistId: SPECIALIST_ID,
      signingKey: SIGNING_KEY,
    });
    const decoded = decodeCursor({
      token,
      specialistId: SPECIALIST_ID,
      signingKey: SIGNING_KEY,
      now: () => NOW,
    });
    expect(decoded).toEqual(payload);
  });
});

// ── 404 ─────────────────────────────────────────────────────────────────────

describe("handleGetCaseNotes — not found", () => {
  it("404 RESOURCE_NOT_FOUND when the PE id does not resolve + no audit row", async () => {
    const { store, seed } = makeStore();
    const token = seed();
    const { client } = makeRestClient({ notFound: true });
    const audit = makeAuditCapture();
    const res = await handleGetCaseNotes(
      caseNotesReq(token),
      routeCtx(),
      baseOptions(store, { restClient: client, writeAudit: audit.writer }),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("RESOURCE_NOT_FOUND");
    expect(audit.audits).toHaveLength(0);
  });
});

// ── VR-15 authz ─────────────────────────────────────────────────────────────

describe("handleGetCaseNotes — VR-15 authz gate", () => {
  it("200 + SUCCESS audit for SPECIALIST when the PE owner is the caller", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient({ ownerId: SPECIALIST_ID });
    const audit = makeAuditCapture();
    const res = await handleGetCaseNotes(
      caseNotesReq(token),
      routeCtx(),
      baseOptions(store, { restClient: client, writeAudit: audit.writer }),
    );
    expect(res.status).toBe(200);
    expect(audit.audits[0]).toMatchObject({
      actionType: "participant.case_notes_listed",
      outcome: "SUCCESS",
      participantId: PARTICIPANT_ID,
    });
  });

  it("403 NOT_IN_OWN_CASELOAD + FAILED audit for SPECIALIST when PE owner is someone else", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient({ ownerId: OTHER_SPECIALIST_ID });
    const audit = makeAuditCapture();
    const res = await handleGetCaseNotes(
      caseNotesReq(token),
      routeCtx(),
      baseOptions(store, { restClient: client, writeAudit: audit.writer }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("NOT_IN_OWN_CASELOAD");
    expect(audit.audits).toHaveLength(1);
    expect(audit.audits[0]).toMatchObject({
      outcome: "FAILED",
      payloadMetadata: expect.objectContaining({ failure_phase: "authz" }),
    });
  });

  it("200 for VP regardless of PE owner", async () => {
    const { store, seed } = makeStore();
    const token = seed("VP");
    const { client } = makeRestClient({ ownerId: OTHER_SPECIALIST_ID });
    const res = await handleGetCaseNotes(
      caseNotesReq(token),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    expect(res.status).toBe(200);
  });

  it("403 ROLE_INSUFFICIENT_SCOPE (supervisor_scope_unmapped) for SUPERVISOR + FAILED audit", async () => {
    const { store, seed } = makeStore();
    const token = seed("SUPERVISOR");
    const { client } = makeRestClient();
    const audit = makeAuditCapture();
    const res = await handleGetCaseNotes(
      caseNotesReq(token),
      routeCtx(),
      baseOptions(store, { restClient: client, writeAudit: audit.writer }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as {
      code: string;
      details?: { reason?: string };
    };
    expect(body.code).toBe("ROLE_INSUFFICIENT_SCOPE");
    expect(body.details?.reason).toBe("supervisor_scope_unmapped");
    expect(audit.audits[0]?.outcome).toBe("FAILED");
  });

  it("403 ROLE_INSUFFICIENT_SCOPE (role_not_permitted) for SYSTEM_ADMIN + FAILED audit", async () => {
    const { store, seed } = makeStore();
    const token = seed("SYSTEM_ADMIN");
    const { client } = makeRestClient();
    const audit = makeAuditCapture();
    const res = await handleGetCaseNotes(
      caseNotesReq(token),
      routeCtx(),
      baseOptions(store, { restClient: client, writeAudit: audit.writer }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as {
      code: string;
      details?: { reason?: string };
    };
    expect(body.code).toBe("ROLE_INSUFFICIENT_SCOPE");
    expect(body.details?.reason).toBe("role_not_permitted");
    expect(audit.audits[0]?.outcome).toBe("FAILED");
  });
});

// ── SF error mapping ────────────────────────────────────────────────────────

describe("handleGetCaseNotes — SF error paths", () => {
  it("503 SF_UPSTREAM_UNAVAILABLE + FAILED audit on transient SF error during identity lookup", async () => {
    const { store, seed } = makeStore();
    const token = seed();
    const { client } = makeRestClient({
      queryError: new SalesforceError(
        "SF_NETWORK_TIMEOUT",
        "timeout connecting to salesforce",
        504,
      ),
    });
    const audit = makeAuditCapture();
    const res = await handleGetCaseNotes(
      caseNotesReq(token),
      routeCtx(),
      baseOptions(store, { restClient: client, writeAudit: audit.writer }),
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("SF_UPSTREAM_UNAVAILABLE");
    expect(audit.audits[0]).toMatchObject({
      actionType: "participant.case_notes_listed",
      outcome: "FAILED",
      payloadMetadata: expect.objectContaining({
        sf_code: "SF_NETWORK_TIMEOUT",
        failure_phase: "identity_lookup",
      }),
    });
  });

  it("503 + FAILED audit on SF error inside the case-notes query path", async () => {
    const { store, seed } = makeStore();
    const token = seed();
    const { client } = makeRestClient();
    const audit = makeAuditCapture();
    const sfErr = new SalesforceError(
      "SF_QUOTA_EXCEEDED",
      "quota exceeded",
      403,
    );
    const failingQuery: CaseNotesQueryFn = () => Promise.reject(sfErr);
    const res = await handleGetCaseNotes(
      caseNotesReq(token),
      routeCtx(),
      baseOptions(store, {
        restClient: client,
        writeAudit: audit.writer,
        caseNotesQuery: failingQuery,
      }),
    );
    expect(res.status).toBe(503);
    expect(audit.audits[0]).toMatchObject({
      outcome: "FAILED",
      payloadMetadata: expect.objectContaining({
        sf_code: "SF_QUOTA_EXCEEDED",
        failure_phase: "case_notes_query",
      }),
    });
  });
});

// ── response shape ──────────────────────────────────────────────────────────

describe("handleGetCaseNotes — response shape", () => {
  it("happy path returns the schema-gap empty page with API §7.1.3 envelope", async () => {
    const { store, seed } = makeStore();
    const token = seed();
    const { client } = makeRestClient();
    const res = await handleGetCaseNotes(
      caseNotesReq(token),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Trace-Id")).not.toBeNull();
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = (await res.json()) as {
      items: unknown[];
      page: { nextCursor: string | null; hasMore: boolean; limit: number };
      dataIssues: string[];
    };
    expect(body.items).toEqual([]);
    expect(body.page).toEqual({ nextCursor: null, hasMore: false, limit: 30 });
    expect(body.dataIssues).toContain("schema_gap_no_case_note_pe_link");
  });

  it("echoes limit back in the page envelope", async () => {
    const { store, seed } = makeStore();
    const token = seed();
    const { client } = makeRestClient();
    const res = await handleGetCaseNotes(
      caseNotesReq(token, "limit=50"),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    const body = (await res.json()) as { page: { limit: number } };
    expect(body.page.limit).toBe(50);
  });

  it("signs the nextCursor when the SF seam returns a seed", async () => {
    const { store, seed } = makeStore();
    const token = seed();
    const { client } = makeRestClient();
    const populated: CaseNotesQueryFn = () =>
      Promise.resolve<CaseNotesQueryResult>({
        items: [
          {
            caseNoteId: "a0M0123456789ABCDE",
            participantId: PARTICIPANT_ID,
            type: "Check In",
            contactType: "phone",
            status: "Completed",
            summary: "Reached participant; confirmed Tuesday appointment.",
            serviceDate: "2026-05-23",
            occurredAt: "2026-05-23T15:23:00Z",
            loggedBy: SPECIALIST_ID,
            source: "tool",
            sfRecordId: "a0M0123456789ABCDE",
          },
        ],
        hasMore: true,
        nextCursorSeed: {
          t: "2026-05-23T15:23:00.000Z",
          id: "a0M0123456789ABCDE",
        },
        schemaGap: false,
      });
    const res = await handleGetCaseNotes(
      caseNotesReq(token),
      routeCtx(),
      baseOptions(store, { restClient: client, caseNotesQuery: populated }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: unknown[];
      page: { nextCursor: string | null; hasMore: boolean };
      dataIssues: string[];
    };
    expect(body.items).toHaveLength(1);
    expect(body.page.hasMore).toBe(true);
    expect(body.page.nextCursor).not.toBeNull();
    // dataIssues should NOT contain the schema-gap marker once the real query
    // is wired (the SPA's "limited timeline" badge drops off automatically).
    expect(body.dataIssues).not.toContain("schema_gap_no_case_note_pe_link");

    const decoded = decodeCursor({
      token: body.page.nextCursor as string,
      specialistId: SPECIALIST_ID,
      signingKey: SIGNING_KEY,
      now: () => NOW,
    });
    expect(decoded).toEqual({
      t: "2026-05-23T15:23:00.000Z",
      id: "a0M0123456789ABCDE",
    });
  });
});

// ── PII firewall ────────────────────────────────────────────────────────────

describe("handleGetCaseNotes — PII firewall on audit metadata", () => {
  it("never carries summary / case-note ids in payload_metadata", async () => {
    const { store, seed } = makeStore();
    const token = seed();
    const { client } = makeRestClient();
    const audit = makeAuditCapture();
    const populated: CaseNotesQueryFn = () =>
      Promise.resolve<CaseNotesQueryResult>({
        items: [
          {
            caseNoteId: "a0M0123456789ABCDE",
            participantId: PARTICIPANT_ID,
            type: "Check In",
            contactType: "phone",
            status: "Completed",
            summary: "PII-SENSITIVE-MARKER-DO-NOT-LEAK",
            serviceDate: "2026-05-23",
            occurredAt: "2026-05-23T15:23:00Z",
            loggedBy: SPECIALIST_ID,
            source: "tool",
            sfRecordId: "a0M0123456789ABCDE",
          },
        ],
        hasMore: false,
        nextCursorSeed: null,
        schemaGap: false,
      });
    const res = await handleGetCaseNotes(
      caseNotesReq(token),
      routeCtx(),
      baseOptions(store, {
        restClient: client,
        writeAudit: audit.writer,
        caseNotesQuery: populated,
      }),
    );
    expect(res.status).toBe(200);
    const metaJson = JSON.stringify(audit.audits[0]?.payloadMetadata ?? {});
    expect(metaJson).not.toContain("PII-SENSITIVE-MARKER-DO-NOT-LEAK");
    expect(metaJson).not.toContain("a0M0123456789ABCDE");
  });
});
