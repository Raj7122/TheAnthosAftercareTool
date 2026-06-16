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

import { handleGetParticipant } from "../../src/participants/get-participant.js";
import type { GetParticipantHandlerOptions } from "../../src/participants/get-participant.js";
import type {
  ScoreCaseloadResult,
  ScoredParticipant,
} from "../../src/caseload/score-caseload.js";
import type { SessionRecord, SessionStore } from "../../src/session/store.js";
import { makeEngineOutput, makeScored } from "../caseload/_fixtures.js";
import {
  makeBarrier,
  makeIncident,
  makeSnapshot,
} from "../calibration/_fixtures.js";

// ── fixtures ────────────────────────────────────────────────────────────────

const SESSION_CONFIG = loadSessionConfig({});
const HOUR = 60 * 60 * 1000;
const SPECIALIST_ID = "0058K00000XYZAbQAO";
const OTHER_SPECIALIST_ID = "0058K00000QQQXXxQAO";
const PARTICIPANT_ID = "a015g00000ABCDxQAO";
const NOW = new Date("2026-05-23T15:30:00Z");
const CONFIG = getCalibrationConfiguration();
const FAKE_DB = {} as unknown as DbOrTx;

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
  identityOverrides?: Partial<IdentityRecord>;
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
    ...opts.identityOverrides,
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
  // Only `query` is exercised on the identity-hydration path.
  const client = { query: queryFn } as unknown as
    import("@anthos/integrations").SalesforceRestClient;
  return { client, queryFn };
}

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

function makeScoreCaseload(
  participantId: string = PARTICIPANT_ID,
  ownerId: string = SPECIALIST_ID,
  scoredOverride?: ScoredParticipant | null,
): NonNullable<GetParticipantHandlerOptions["scoreCaseloadImpl"]> {
  return vi.fn(() => {
    const scored =
      scoredOverride === null
        ? []
        : scoredOverride !== undefined
          ? [scoredOverride]
          : [
              makeScored(
                makeSnapshot(participantId, ownerId, {
                  barriers: [
                    makeBarrier({
                      id: "barrier-1",
                      type: "PA issue",
                      status: "Open",
                      stage: "Aftercare",
                      startDate: new Date("2026-05-01T00:00:00Z"),
                    }),
                  ],
                  incidents: [makeIncident()],
                }),
                makeEngineOutput(participantId, {
                  priorityScore: 89.2,
                  tier: 1,
                  tierLabel: "Triage today",
                  factors: [
                    {
                      key: "days_since_last_contact",
                      name: "Days since last successful contact",
                      valueLabel: "21 days",
                      valueNumeric: 21,
                      weight: "×1.5",
                      pointsContributed: 22,
                      weightRaw: 1.5,
                    },
                  ],
                  triggeredInvariants: [
                    {
                      invariantId: "BR-24-no-contact-30",
                      displayLabel: "No contact in 30 days",
                    },
                  ],
                }),
              ),
            ];
    return Promise.resolve({
      scored,
      roundTrips: 2,
      hydratedAt: NOW,
      configuration: CONFIG,
      now: NOW,
    }) as Promise<ScoreCaseloadResult>;
  });
}

interface AuditCapture {
  audits: Array<{
    actionType: string;
    outcome: string;
    participantId?: string;
    payloadMetadata?: Record<string, unknown>;
  }>;
  writer: NonNullable<GetParticipantHandlerOptions["writeAudit"]>;
}

function makeAuditCapture(): AuditCapture {
  const audits: AuditCapture["audits"] = [];
  const writer: NonNullable<GetParticipantHandlerOptions["writeAudit"]> = vi.fn(
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

function detailReq(
  token: string | undefined,
  participantId: string = PARTICIPANT_ID,
): Request {
  const headers = new Headers();
  if (token !== undefined) headers.set("Cookie", `anthos_session=${token}`);
  return new Request(
    `https://bff.test/api/v1/participants/${participantId}`,
    { method: "GET", headers },
  );
}

function routeCtx(participantId: string = PARTICIPANT_ID) {
  return { params: Promise.resolve({ id: participantId }) };
}

function baseOptions(
  store: SessionStore,
  overrides: Partial<GetParticipantHandlerOptions> = {},
): GetParticipantHandlerOptions {
  const audit = overrides.writeAudit ?? makeAuditCapture().writer;
  return {
    store,
    sessionConfig: SESSION_CONFIG,
    db: FAKE_DB,
    writeAudit: audit,
    salesforceAuth: FAKE_AUTH,
    scoreCaseloadImpl: makeScoreCaseload(),
    configuration: CONFIG,
    now: () => NOW,
    ...overrides,
  };
}

// ── auth gate ────────────────────────────────────────────────────────────────

describe("handleGetParticipant — auth gate", () => {
  it("401 AUTH_SESSION_INVALID when no session cookie is present", async () => {
    const { store } = makeStore();
    const { client } = makeRestClient();
    const res = await handleGetParticipant(
      detailReq(undefined),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    expect(res.status).toBe(401);
  });
});

// ── path-param validation ───────────────────────────────────────────────────

describe("handleGetParticipant — path-param validation", () => {
  it("422 VALIDATION_FAILED for a malformed Salesforce Id", async () => {
    const { store, seed } = makeStore();
    const token = seed();
    const { client } = makeRestClient();
    const res = await handleGetParticipant(
      detailReq(token, "not-a-sf-id"),
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

// ── 404 ─────────────────────────────────────────────────────────────────────

describe("handleGetParticipant — not found", () => {
  it("404 RESOURCE_NOT_FOUND when the PE id does not resolve", async () => {
    const { store, seed } = makeStore();
    const token = seed();
    const { client } = makeRestClient({ notFound: true });
    const audit = makeAuditCapture();
    const res = await handleGetParticipant(
      detailReq(token),
      routeCtx(),
      baseOptions(store, { restClient: client, writeAudit: audit.writer }),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("RESOURCE_NOT_FOUND");
    // A 404 is not an upstream failure — no audit row is emitted (mirrors the
    // create-barrier 4xx-pre-mutation precedent).
    expect(audit.audits).toHaveLength(0);
  });
});

// ── VR-15 authz ─────────────────────────────────────────────────────────────

describe("handleGetParticipant — VR-15 authz gate", () => {
  it("200 for SPECIALIST when the PE owner is the caller", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient({ ownerId: SPECIALIST_ID });
    const res = await handleGetParticipant(
      detailReq(token),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    expect(res.status).toBe(200);
  });

  it("403 NOT_IN_OWN_CASELOAD for SPECIALIST when the PE owner is someone else", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient({ ownerId: OTHER_SPECIALIST_ID });
    const res = await handleGetParticipant(
      detailReq(token),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("NOT_IN_OWN_CASELOAD");
  });

  it("403 NOT_IN_OWN_CASELOAD for SPECIALIST when the PE has a null owner", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient({ ownerId: null });
    const res = await handleGetParticipant(
      detailReq(token),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("NOT_IN_OWN_CASELOAD");
  });

  it("200 for VP regardless of PE owner", async () => {
    const { store, seed } = makeStore();
    const token = seed("VP");
    const { client } = makeRestClient({ ownerId: OTHER_SPECIALIST_ID });
    const res = await handleGetParticipant(
      detailReq(token),
      routeCtx(),
      baseOptions(store, {
        restClient: client,
        scoreCaseloadImpl: makeScoreCaseload(PARTICIPANT_ID, OTHER_SPECIALIST_ID),
      }),
    );
    expect(res.status).toBe(200);
  });

  it("403 ROLE_INSUFFICIENT_SCOPE (supervisor_scope_unmapped) for SUPERVISOR", async () => {
    const { store, seed } = makeStore();
    const token = seed("SUPERVISOR");
    const { client } = makeRestClient();
    const res = await handleGetParticipant(
      detailReq(token),
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

  it("403 ROLE_INSUFFICIENT_SCOPE (role_not_permitted) for SYSTEM_ADMIN", async () => {
    const { store, seed } = makeStore();
    const token = seed("SYSTEM_ADMIN");
    const { client } = makeRestClient();
    const res = await handleGetParticipant(
      detailReq(token),
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
});

// ── SF error mapping ────────────────────────────────────────────────────────

describe("handleGetParticipant — SF error paths", () => {
  it("503 SF_UPSTREAM_UNAVAILABLE on transient SF errors during identity lookup + emits FAILED audit", async () => {
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
    const res = await handleGetParticipant(
      detailReq(token),
      routeCtx(),
      baseOptions(store, { restClient: client, writeAudit: audit.writer }),
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("SF_UPSTREAM_UNAVAILABLE");
    expect(audit.audits).toHaveLength(1);
    expect(audit.audits[0]).toMatchObject({
      actionType: "participant.detail_viewed",
      outcome: "FAILED",
      participantId: PARTICIPANT_ID,
      payloadMetadata: expect.objectContaining({
        sf_code: "SF_NETWORK_TIMEOUT",
        failure_phase: "identity_lookup",
      }),
    });
  });

  it("403 ROLE_INSUFFICIENT_SCOPE when SF returns FLS denied during identity lookup", async () => {
    const { store, seed } = makeStore();
    const token = seed();
    const { client } = makeRestClient({
      queryError: new SalesforceError(
        "SF_FIELD_FLS_DENIED",
        "field-level security denied",
        403,
      ),
    });
    const res = await handleGetParticipant(
      detailReq(token),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("ROLE_INSUFFICIENT_SCOPE");
  });

  it("503 + FAILED audit on transient SF error during scoring", async () => {
    const { store, seed } = makeStore();
    const token = seed();
    const { client } = makeRestClient();
    const audit = makeAuditCapture();
    const scoreErr = new SalesforceError(
      "SF_QUOTA_EXCEEDED",
      "quota exceeded",
      403,
    );
    const res = await handleGetParticipant(
      detailReq(token),
      routeCtx(),
      baseOptions(store, {
        restClient: client,
        writeAudit: audit.writer,
        scoreCaseloadImpl: vi.fn(() => Promise.reject(scoreErr)),
      }),
    );
    expect(res.status).toBe(503);
    expect(audit.audits).toHaveLength(1);
    expect(audit.audits[0]).toMatchObject({
      outcome: "FAILED",
      payloadMetadata: expect.objectContaining({
        failure_phase: "scoring",
        sf_code: "SF_QUOTA_EXCEEDED",
      }),
    });
  });
});

// ── response shape ──────────────────────────────────────────────────────────

describe("handleGetParticipant — response shape", () => {
  it("returns the spec'd identity + priority block on the happy path", async () => {
    const { store, seed } = makeStore();
    const token = seed();
    const { client } = makeRestClient();
    const res = await handleGetParticipant(
      detailReq(token),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      participantId: PARTICIPANT_ID,
      displayName: "Mileena Lesane",
      enrollmentCode: "PE-10/2024",
      aftercareStartDate: "2024-10-15",
      programStatus: "Aftercare",
      currentTier: 1,
      currentPriorityScore: 89.2,
    });
    expect(body.aftercareDay).toBeGreaterThan(0);
    expect(body.factors).toHaveLength(1);
    expect(body.triggered_invariants).toHaveLength(1);
    expect(body.openBarriers).toHaveLength(1);
  });

  it("stubs communicationConsent + preferredContactMethod as null (no SF source)", async () => {
    const { store, seed } = makeStore();
    const token = seed();
    const { client } = makeRestClient();
    const res = await handleGetParticipant(
      detailReq(token),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    const body = (await res.json()) as {
      preferredContactMethod: unknown;
      communicationConsent: Record<string, unknown>;
    };
    expect(body.preferredContactMethod).toBeNull();
    expect(body.communicationConsent).toEqual({
      sms: null,
      email: null,
      smsConsentVerifiedAt: null,
    });
  });

  it("phoneRevealable is false (no reveal-permission mechanism yet)", async () => {
    const { store, seed } = makeStore();
    const token = seed();
    const { client } = makeRestClient();
    const res = await handleGetParticipant(
      detailReq(token),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    const body = (await res.json()) as { contact: { phoneRevealable: boolean } };
    expect(body.contact.phoneRevealable).toBe(false);
  });

  it("recentContacts[] is empty when the PE rollup carries no case note", async () => {
    const { store, seed } = makeStore();
    const token = seed();
    const { client } = makeRestClient(); // default rollup fields are all null
    const res = await handleGetParticipant(
      detailReq(token),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    const body = (await res.json()) as { recentContacts: unknown[] };
    expect(body.recentContacts).toEqual([]);
  });

  it("recentContacts[] surfaces one PE-rollup row when the rollup is populated", async () => {
    const { store, seed } = makeStore();
    const token = seed();
    const { client } = makeRestClient({
      identityOverrides: {
        Most_Recent_Case_Note__c: "2026-05-20T15:00:00.000+0000",
        Most_Recent_Case_Note_Status__c: "Completed",
        Most_Recent_Case_Note_Type__c: "Check In",
        Most_Recent_Case_Note_Text__c: "Confirmed Tuesday appointment.",
      },
    });
    const res = await handleGetParticipant(
      detailReq(token),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    const body = (await res.json()) as {
      recentContacts: Array<{
        type: string;
        caseNoteType: string | null;
        contactType: string | null;
        status: string | null;
        summary: string | null;
        timestamp: string | null;
        provenance: string;
      }>;
    };
    expect(body.recentContacts).toHaveLength(1);
    expect(body.recentContacts[0]).toMatchObject({
      type: "case_note",
      caseNoteType: "Check In",
      contactType: null,
      status: "Completed",
      summary: "Confirmed Tuesday appointment.",
      provenance: "pe_rollup",
    });
    expect(body.recentContacts[0]?.timestamp).toMatch(
      /^2026-05-20T15:00:00\.000Z$/,
    );
  });

  it("quickActions: SPECIALIST + phone + email → logCall/scheduleVisit enabled; sendSms gated on consent; sendEmail enabled", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient();
    const res = await handleGetParticipant(
      detailReq(token),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    const body = (await res.json()) as { quickActions: Record<string, unknown> };
    expect(body.quickActions).toMatchObject({
      logCall: "enabled",
      sendSms: "disabled",
      sendSmsDisabledReason: "consent_unknown",
      sendEmail: "enabled",
      scheduleVisit: "enabled",
    });
  });

  it("quickActions: SPECIALIST + no phone → sendSms disabled with no_phone_on_file", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient({
      identityOverrides: { Phone_Number__c: null },
    });
    const res = await handleGetParticipant(
      detailReq(token),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    const body = (await res.json()) as { quickActions: Record<string, unknown> };
    expect(body.quickActions).toMatchObject({
      sendSms: "disabled",
      sendSmsDisabledReason: "no_phone_on_file",
    });
  });

  it("quickActions: SPECIALIST + no email → sendEmail disabled with no_email_on_file", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient({
      identityOverrides: { Primary_Contact_s_Email__c: null },
    });
    const res = await handleGetParticipant(
      detailReq(token),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    const body = (await res.json()) as { quickActions: Record<string, unknown> };
    expect(body.quickActions).toMatchObject({
      sendEmail: "disabled",
      sendEmailDisabledReason: "no_email_on_file",
    });
  });

  it("dataIssues includes score_unresolved when the participant is absent from the scored caseload", async () => {
    const { store, seed } = makeStore();
    const token = seed();
    const { client } = makeRestClient();
    // Scoring returns an empty caseload — soft-degraded path.
    const res = await handleGetParticipant(
      detailReq(token),
      routeCtx(),
      baseOptions(store, {
        restClient: client,
        scoreCaseloadImpl: makeScoreCaseload(PARTICIPANT_ID, SPECIALIST_ID, null),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      dataIssues: string[];
      currentTier: number | null;
      currentPriorityScore: number | null;
      factors: unknown[];
      perCheckpointBreakdown: unknown[];
    };
    expect(body.dataIssues).toContain("score_unresolved");
    expect(body.currentTier).toBeNull();
    expect(body.currentPriorityScore).toBeNull();
    expect(body.factors).toEqual([]);
    // Degraded path: snapshot === null → empty breakdown (parity with
    // EMPTY_CYCLE_STATUS).
    expect(body.perCheckpointBreakdown).toEqual([]);
  });
});

// ── F-05 BR-33 per-anchor breakdown (P1F-07) ────────────────────────────────

describe("handleGetParticipant — perCheckpointBreakdown (F-05 BR-33)", () => {
  it("returns [] when the snapshot has no aftercareStartDate", async () => {
    // Default snapshot fixture has aftercareStartDate=null; per-anchor
    // breakdown short-circuits to [] (BR-32 / FS-12 "Not in cycle").
    const { store, seed } = makeStore();
    const token = seed();
    const { client } = makeRestClient();
    const res = await handleGetParticipant(
      detailReq(token),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    const body = (await res.json()) as {
      perCheckpointBreakdown: ReadonlyArray<{ anchor: number; state: string }>;
    };
    expect(body.perCheckpointBreakdown).toEqual([]);
  });

  it("returns 4 rows in ascending anchor order when aftercareStartDate is hydrated", async () => {
    // Aftercare started 200 days before NOW (2026-05-23): the 90- and 180-day
    // anchors have passed (uncredited under the SWAP-POINT stub); 270 and 365
    // are still in the future. The fact that we get back exactly 4 rows in
    // [90, 180, 270, 365] order is the contract the SPA renders against.
    const aftercareStart = new Date("2025-11-04T00:00:00Z"); // ~200 days before NOW
    const { store, seed } = makeStore();
    const token = seed();
    const { client } = makeRestClient();
    const scored = makeScored(
      makeSnapshot(PARTICIPANT_ID, SPECIALIST_ID, {
        enrollment: { aftercareStartDate: aftercareStart },
      }),
      makeEngineOutput(PARTICIPANT_ID),
    );
    const res = await handleGetParticipant(
      detailReq(token),
      routeCtx(),
      baseOptions(store, {
        restClient: client,
        scoreCaseloadImpl: makeScoreCaseload(
          PARTICIPANT_ID,
          SPECIALIST_ID,
          scored,
        ),
      }),
    );
    const body = (await res.json()) as {
      perCheckpointBreakdown: ReadonlyArray<{ anchor: number; state: string }>;
    };
    expect(body.perCheckpointBreakdown).toHaveLength(4);
    expect(body.perCheckpointBreakdown.map((r) => r.anchor)).toEqual([
      90, 180, 270, 365,
    ]);
  });

  it("BR-26 Option A: older missed anchor surfaces as catch_up, freshest miss as overdue", async () => {
    // Aftercare started 200 days before NOW: 90 and 180 are both past with no
    // credit (SWAP POINT: completedStabilityMeetings is []). Under BR-26
    // Option A, 180 (the freshest miss / most-recent passed) is `overdue` and
    // 90 (the older miss) is `catch_up`. The SPA-side variant mapping then
    // renders them with distinct Badge variants (asserted in
    // apps/web/test/participants/cycle-anchor-label.test.ts).
    const aftercareStart = new Date("2025-11-04T00:00:00Z");
    const { store, seed } = makeStore();
    const token = seed();
    const { client } = makeRestClient();
    const scored = makeScored(
      makeSnapshot(PARTICIPANT_ID, SPECIALIST_ID, {
        enrollment: { aftercareStartDate: aftercareStart },
      }),
      makeEngineOutput(PARTICIPANT_ID),
    );
    const res = await handleGetParticipant(
      detailReq(token),
      routeCtx(),
      baseOptions(store, {
        restClient: client,
        scoreCaseloadImpl: makeScoreCaseload(
          PARTICIPANT_ID,
          SPECIALIST_ID,
          scored,
        ),
      }),
    );
    const body = (await res.json()) as {
      perCheckpointBreakdown: ReadonlyArray<{ anchor: number; state: string }>;
    };
    const byAnchor = Object.fromEntries(
      body.perCheckpointBreakdown.map((r) => [r.anchor, r.state]),
    );
    expect(byAnchor[90]).toBe("catch_up");
    expect(byAnchor[180]).toBe("overdue");
    expect(byAnchor[270]).toBe("future");
    expect(byAnchor[365]).toBe("future");
  });
});

// ── audit + headers ─────────────────────────────────────────────────────────

describe("handleGetParticipant — audit + headers", () => {
  it("writes a SUCCESS audit row with participant.detail_viewed BEFORE the response", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { client } = makeRestClient();
    const audit = makeAuditCapture();
    const res = await handleGetParticipant(
      detailReq(token),
      routeCtx(),
      baseOptions(store, { restClient: client, writeAudit: audit.writer }),
    );
    expect(res.status).toBe(200);
    expect(audit.audits).toHaveLength(1);
    expect(audit.audits[0]).toMatchObject({
      actionType: "participant.detail_viewed",
      outcome: "SUCCESS",
      participantId: PARTICIPANT_ID,
    });
    // No PII fields in `payload_metadata` — only derived counts, role, and the
    // score-resolved flag. `displayName` MUST NOT appear there.
    const meta = audit.audits[0]?.payloadMetadata ?? {};
    expect(meta).toHaveProperty("role", "SPECIALIST");
    expect(meta).toHaveProperty("role_view_mode", "write");
    expect(meta).toHaveProperty("factor_count");
    expect(meta).toHaveProperty("open_barrier_count");
    expect(meta).not.toHaveProperty("displayName");
    expect(meta).not.toHaveProperty("phone");
    expect(meta).not.toHaveProperty("email");
  });

  it("audit role_view_mode is read_only for VP-not-applicable / SUPERVISOR cases short-circuit before audit", async () => {
    // SUPERVISOR is denied before the success audit row writes — covered above
    // in the authz block. This test confirms the SUCCESS row for VP carries
    // role_view_mode=write (VP retains write semantics in the detail body even
    // though the F-07 product surface treats VP as read-only at the UI layer).
    const { store, seed } = makeStore();
    const token = seed("VP");
    const { client } = makeRestClient({ ownerId: OTHER_SPECIALIST_ID });
    const audit = makeAuditCapture();
    await handleGetParticipant(
      detailReq(token),
      routeCtx(),
      baseOptions(store, {
        restClient: client,
        writeAudit: audit.writer,
        scoreCaseloadImpl: makeScoreCaseload(PARTICIPANT_ID, OTHER_SPECIALIST_ID),
      }),
    );
    expect(audit.audits[0]?.payloadMetadata).toMatchObject({
      role: "VP",
      role_view_mode: "write",
    });
  });

  it("response carries Cache-Control: no-store and X-Trace-Id", async () => {
    const { store, seed } = makeStore();
    const token = seed();
    const { client } = makeRestClient();
    const res = await handleGetParticipant(
      detailReq(token),
      routeCtx(),
      baseOptions(store, { restClient: client }),
    );
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Trace-Id")).not.toBeNull();
  });
});
