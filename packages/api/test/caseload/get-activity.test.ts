import { hashToken, loadSessionConfig, mintToken } from "@anthos/auth";
import type { Role } from "@anthos/auth";
import { assertNoPii } from "@anthos/audit";
import {
  SalesforceError,
  type CaseloadActivityRecords,
  type OwnedEnrollment,
  type SalesforceAuth,
} from "@anthos/integrations";
import type { DbOrTx } from "@anthos/persistence";
import { describe, expect, it, vi } from "vitest";

import type { CaseloadActivityBody } from "../../src/caseload/activity-dto.js";
import { handleCaseloadActivity } from "../../src/caseload/get-activity.js";
import type { CaseloadActivityHandlerOptions } from "../../src/caseload/get-activity.js";
import type { SessionRecord, SessionStore } from "../../src/session/store.js";

const SESSION_CONFIG = loadSessionConfig({});
const HOUR = 60 * 60 * 1000;
const SPECIALIST_ID = "0058K00000XYZAbQAO";
const NOW = new Date("2026-06-15T12:00:00Z");
const FAKE_DB = {} as unknown as DbOrTx;
const FAKE_AUTH: SalesforceAuth = {
  getAccessToken: () => Promise.resolve("FAKE"),
  getInstanceUrl: () => Promise.resolve("https://fake.my.salesforce.com"),
};
const PE = "a1kU800000pjmA1IAI";

function makeStore(): { store: SessionStore; seed: (role?: Role) => string } {
  const rows = new Map<string, SessionRecord>();
  let n = 0;
  const store: SessionStore = {
    create: () => Promise.reject(new Error("unused")),
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

function req(token?: string, params?: Record<string, string>): Request {
  const headers = new Headers();
  if (token !== undefined) headers.set("Cookie", `anthos_session=${token}`);
  const url = new URL("https://bff.test/api/v1/caseload/activity");
  for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v);
  return new Request(url, { method: "GET", headers });
}

const EMPTY_ACTIVITY: CaseloadActivityRecords = { caseNotes: [], sms: [] };

function baseOptions(
  store: SessionStore,
  overrides: Partial<CaseloadActivityHandlerOptions> = {},
): CaseloadActivityHandlerOptions {
  return {
    store,
    sessionConfig: SESSION_CONFIG,
    salesforceAuth: FAKE_AUTH,
    db: FAKE_DB,
    writeAudit: vi.fn(() => Promise.resolve({ id: "audit-1" })),
    now: () => NOW,
    queryOwnedEnrollmentsImpl: () => Promise.resolve([{ id: PE, name: "Casey Rivera" }]),
    queryActivityImpl: () => Promise.resolve(EMPTY_ACTIVITY),
    ...overrides,
  };
}

describe("handleCaseloadActivity — auth + validation", () => {
  it("401 when no session cookie", async () => {
    const { store } = makeStore();
    const res = await handleCaseloadActivity(req(), baseOptions(store));
    expect(res.status).toBe(401);
  });

  it("422 on a malformed from date", async () => {
    const { store, seed } = makeStore();
    const res = await handleCaseloadActivity(
      req(seed(), { from: "06/01/2026", to: "2026-06-30" }),
      baseOptions(store),
    );
    expect(res.status).toBe(422);
    expect(((await res.json()) as { details: { reason: string } }).details.reason).toBe("invalid_date");
  });

  it("422 when the window exceeds the cap", async () => {
    const { store, seed } = makeStore();
    const res = await handleCaseloadActivity(
      req(seed(), { from: "2026-01-01", to: "2026-12-31" }),
      baseOptions(store),
    );
    expect(res.status).toBe(422);
    expect(((await res.json()) as { details: { reason: string } }).details.reason).toBe("window_too_large");
  });
});

describe("handleCaseloadActivity — happy path", () => {
  it("returns merged metadata-only events + writes one metadata-only SUCCESS audit", async () => {
    const { store, seed } = makeStore();
    const writeAudit = vi.fn(() => Promise.resolve({ id: "a1" }));
    const res = await handleCaseloadActivity(
      req(seed(), { from: "2026-06-01", to: "2026-06-30" }),
      baseOptions(store, {
        writeAudit,
        queryActivityImpl: () =>
          Promise.resolve({
            caseNotes: [
              {
                Id: "cn1",
                Program_Enrollment__c: PE,
                Type__c: "Stability Meeting",
                Status__c: "Scheduled",
                Contact_Type__c: "In Person",
                Service_Date__c: "2026-06-20",
              },
            ],
            sms: [
              {
                Id: "sms1",
                Program_Enrollment__c: PE,
                Mogli_SMS__Direction__c: "Outgoing",
                Mogli_SMS__Status__c: "Queued",
                CreatedDate: "2026-06-10T14:00:00.000+0000",
              },
            ],
          }),
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as CaseloadActivityBody;
    expect(body.window).toEqual({ from: "2026-06-01", to: "2026-06-30" });
    expect(body.items).toHaveLength(2);
    expect(body.items.find((e) => e.kind === "visit")).toMatchObject({
      status: "scheduled",
      participantName: "Casey Rivera",
    });

    expect(writeAudit).toHaveBeenCalledTimes(1);
    const entry = writeAudit.mock.calls[0]![1] as {
      actionType: string;
      outcome: string;
      payloadMetadata: Record<string, unknown>;
    };
    expect(entry.actionType).toBe("caseload.activity_listed");
    expect(entry.outcome).toBe("SUCCESS");
    // Metadata-only: counts + window, no participant ids/names.
    expect(entry.payloadMetadata).toMatchObject({
      owned_pe_count: 1,
      case_notes_count: 1,
      sms_count: 1,
      from: "2026-06-01",
      to: "2026-06-30",
    });
    const metaStr = JSON.stringify(entry.payloadMetadata);
    expect(metaStr).not.toContain("Casey");
    expect(metaStr).not.toContain(PE);
    // Regression: the payload must pass the real no-PII assertion the writer
    // runs (a denied-key segment like `note` would 500 at runtime — it did).
    expect(() => assertNoPii(entry.payloadMetadata)).not.toThrow();
  });

  it("short-circuits an empty caseload without an activity query", async () => {
    const { store, seed } = makeStore();
    const queryActivityImpl = vi.fn(() => Promise.resolve(EMPTY_ACTIVITY));
    const res = await handleCaseloadActivity(
      req(seed()),
      baseOptions(store, {
        queryOwnedEnrollmentsImpl: () => Promise.resolve([] as OwnedEnrollment[]),
        queryActivityImpl,
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as CaseloadActivityBody;
    expect(body.items).toEqual([]);
    expect(queryActivityImpl).not.toHaveBeenCalled();
  });
});

describe("handleCaseloadActivity — Salesforce error", () => {
  it("maps a transient SF error to 503 and writes a FAILED audit", async () => {
    const { store, seed } = makeStore();
    const writeAudit = vi.fn(() => Promise.resolve({ id: "a1" }));
    const res = await handleCaseloadActivity(
      req(seed()),
      baseOptions(store, {
        writeAudit,
        queryOwnedEnrollmentsImpl: () =>
          Promise.reject(new SalesforceError("SF_NETWORK_TIMEOUT", "timed out")),
      }),
    );
    expect(res.status).toBe(503);
    expect(writeAudit).toHaveBeenCalledTimes(1);
    expect((writeAudit.mock.calls[0]![1] as { outcome: string }).outcome).toBe("FAILED");
  });
});
