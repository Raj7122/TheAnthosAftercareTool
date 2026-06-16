import { describe, expect, it, vi } from "vitest";

import { SalesforceRestClient } from "../../src/salesforce/rest-client.js";
import { SalesforceError, type SalesforceAuth } from "../../src/salesforce/types.js";

// SalesforceRestClient.createRecord (P1E-01). Unit-only — opt-in sandbox
// exercise lives next door in `rest-client.integration.test.ts`. Tests stub
// `fetch` directly, the same pattern bulk-hydration.unit.test.ts uses.

const STATIC_AUTH: SalesforceAuth = {
  getAccessToken: () => Promise.resolve("FAKE_TOKEN"),
  getInstanceUrl: () => Promise.resolve("https://fake.my.salesforce.com"),
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeClient(fetchImpl: typeof fetch): SalesforceRestClient {
  return new SalesforceRestClient({ auth: STATIC_AUTH, fetchImpl });
}

describe("SalesforceRestClient.createRecord — happy path", () => {
  it("POSTs to /sobjects/{type}/ with the supplied fields and returns the SF response", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ id: "a0K5g00000ABCxQAO", success: true, errors: [] }),
    ) as unknown as typeof fetch;
    const client = makeClient(fetchImpl);
    const result = await client.createRecord("Barriers__c", {
      Type__c: "PA issue",
      Stage__c: "Aftercare",
      Start_Date__c: "2026-05-22",
      Program_Enrollment__c: "a015g00000ABCDxQAO",
    });
    expect(result.id).toBe("a0K5g00000ABCxQAO");
    expect(result.success).toBe(true);

    const calls = vi.mocked(fetchImpl).mock.calls;
    expect(calls).toHaveLength(1);
    const [url, init] = calls[0]!;
    expect(String(url)).toBe(
      "https://fake.my.salesforce.com/services/data/v67.0/sobjects/Barriers__c/",
    );
    expect(init?.method).toBe("POST");
    const bodyText = init?.body as string;
    expect(JSON.parse(bodyText)).toMatchObject({
      Type__c: "PA issue",
      Stage__c: "Aftercare",
      Program_Enrollment__c: "a015g00000ABCDxQAO",
    });
    // Authorization header carries the bearer; client header.
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer FAKE_TOKEN");
  });

  it("rejects an invalid sobject identifier (URL injection guard)", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const client = makeClient(fetchImpl);
    await expect(
      client.createRecord("Barriers__c/../../accounts", { Foo__c: 1 }),
    ).rejects.toBeInstanceOf(SalesforceError);
    // Fetch must NOT have been called — the guard runs before any I/O.
    expect(vi.mocked(fetchImpl)).not.toHaveBeenCalled();
  });

  it("throws SF_UNKNOWN when SF returns success=false even on a 2xx", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ id: "", success: false, errors: ["weird"] }),
    ) as unknown as typeof fetch;
    const client = makeClient(fetchImpl);
    await expect(
      client.createRecord("Barriers__c", { Type__c: "PA issue" }),
    ).rejects.toMatchObject({ code: "SF_UNKNOWN" });
  });
});

describe("SalesforceRestClient.updateRecord — happy path (P1E-02)", () => {
  const BARRIER_ID = "a0K5g00000ABCDxQAO";

  it("PATCHes /sobjects/{type}/{id} with the supplied fields and resolves on 204", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: 204 }),
    ) as unknown as typeof fetch;
    const client = makeClient(fetchImpl);
    await expect(
      client.updateRecord("Barriers__c", BARRIER_ID, {
        End_Date__c: "2026-05-23",
      }),
    ).resolves.toBeUndefined();

    const calls = vi.mocked(fetchImpl).mock.calls;
    expect(calls).toHaveLength(1);
    const [url, init] = calls[0]!;
    expect(String(url)).toBe(
      `https://fake.my.salesforce.com/services/data/v67.0/sobjects/Barriers__c/${BARRIER_ID}`,
    );
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(init?.body as string)).toEqual({
      End_Date__c: "2026-05-23",
    });
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer FAKE_TOKEN");
  });

  it("rejects an invalid sobject identifier without firing fetch", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const client = makeClient(fetchImpl);
    await expect(
      client.updateRecord("Barriers__c/../accounts", BARRIER_ID, {
        End_Date__c: "2026-05-23",
      }),
    ).rejects.toBeInstanceOf(SalesforceError);
    expect(vi.mocked(fetchImpl)).not.toHaveBeenCalled();
  });

  it("rejects an invalid record id shape without firing fetch", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const client = makeClient(fetchImpl);
    await expect(
      client.updateRecord("Barriers__c", "not-a-sf-id", {
        End_Date__c: "2026-05-23",
      }),
    ).rejects.toThrow(/recordId is not a valid Salesforce Id/);
    expect(vi.mocked(fetchImpl)).not.toHaveBeenCalled();
  });
});

describe("SalesforceRestClient.updateRecord — DML error mapping (P1E-02)", () => {
  const BARRIER_ID = "a0K5g00000ABCDxQAO";

  it.each<[string, string]>([
    ["REQUIRED_FIELD_MISSING", "SF_VALIDATION_FAILED"],
    ["STRING_TOO_LONG", "SF_VALIDATION_FAILED"],
    ["FIELD_CUSTOM_VALIDATION_EXCEPTION", "SF_VALIDATION_FAILED"],
  ])("400 %s → %s", async (sfErrorCode, expectedCode) => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse([{ errorCode: sfErrorCode, message: "broken" }], 400),
    ) as unknown as typeof fetch;
    const client = makeClient(fetchImpl);
    await expect(
      client.updateRecord("Barriers__c", BARRIER_ID, {
        End_Date__c: "2026-05-23",
      }),
    ).rejects.toMatchObject({ code: expectedCode });
  });

  it("403 INSUFFICIENT_ACCESS_OR_READONLY → SF_FIELD_FLS_DENIED", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        [{ errorCode: "INSUFFICIENT_ACCESS_OR_READONLY", message: "denied" }],
        403,
      ),
    ) as unknown as typeof fetch;
    const client = makeClient(fetchImpl);
    await expect(
      client.updateRecord("Barriers__c", BARRIER_ID, {
        End_Date__c: "2026-05-23",
      }),
    ).rejects.toMatchObject({ code: "SF_FIELD_FLS_DENIED" });
  });

  it("401 → SF_AUTH_FAILED", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse([{ errorCode: "INVALID_SESSION_ID", message: "exp" }], 401),
    ) as unknown as typeof fetch;
    const client = makeClient(fetchImpl);
    await expect(
      client.updateRecord("Barriers__c", BARRIER_ID, {
        End_Date__c: "2026-05-23",
      }),
    ).rejects.toMatchObject({ code: "SF_AUTH_FAILED" });
  });

  it("429 → SF_QUOTA_EXCEEDED", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse([{ errorCode: "REQUEST_LIMIT_EXCEEDED", message: "lim" }], 429),
    ) as unknown as typeof fetch;
    const client = makeClient(fetchImpl);
    await expect(
      client.updateRecord("Barriers__c", BARRIER_ID, {
        End_Date__c: "2026-05-23",
      }),
    ).rejects.toMatchObject({ code: "SF_QUOTA_EXCEEDED" });
  });

  it("AbortError on timeout → SF_NETWORK_TIMEOUT", async () => {
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          const e = new Error("aborted") as Error & { name: string };
          e.name = "AbortError";
          reject(e);
        });
      });
    }) as unknown as typeof fetch;
    const client = new SalesforceRestClient({
      auth: STATIC_AUTH,
      fetchImpl,
      timeoutMs: 5,
    });
    await expect(
      client.updateRecord("Barriers__c", BARRIER_ID, {
        End_Date__c: "2026-05-23",
      }),
    ).rejects.toMatchObject({ code: "SF_NETWORK_TIMEOUT" });
  });
});

describe("SalesforceRestClient.createRecord — DML error mapping (P1E-01)", () => {
  it.each<[string, string]>([
    ["REQUIRED_FIELD_MISSING", "SF_VALIDATION_FAILED"],
    ["STRING_TOO_LONG", "SF_VALIDATION_FAILED"],
    ["INVALID_TYPE_ON_FIELD_IN_RECORD", "SF_VALIDATION_FAILED"],
    ["FIELD_CUSTOM_VALIDATION_EXCEPTION", "SF_VALIDATION_FAILED"],
    ["FIELD_INTEGRITY_EXCEPTION", "SF_VALIDATION_FAILED"],
  ])("400 %s → %s", async (sfErrorCode, expectedCode) => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        [{ errorCode: sfErrorCode, message: "broken" }],
        400,
      ),
    ) as unknown as typeof fetch;
    const client = makeClient(fetchImpl);
    await expect(
      client.createRecord("Barriers__c", { Type__c: "PA issue" }),
    ).rejects.toMatchObject({ code: expectedCode });
  });

  it("403 INSUFFICIENT_ACCESS_OR_READONLY → SF_FIELD_FLS_DENIED", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        [
          {
            errorCode: "INSUFFICIENT_ACCESS_OR_READONLY",
            message: "no create access",
          },
        ],
        403,
      ),
    ) as unknown as typeof fetch;
    const client = makeClient(fetchImpl);
    await expect(
      client.createRecord("Barriers__c", { Type__c: "PA issue" }),
    ).rejects.toMatchObject({ code: "SF_FIELD_FLS_DENIED" });
  });

  it("401 maps to SF_AUTH_FAILED (existing read-side mapping unchanged)", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse([{ errorCode: "INVALID_SESSION_ID", message: "exp" }], 401),
    ) as unknown as typeof fetch;
    const client = makeClient(fetchImpl);
    await expect(
      client.createRecord("Barriers__c", { Type__c: "PA issue" }),
    ).rejects.toMatchObject({ code: "SF_AUTH_FAILED" });
  });

  it("429 maps to SF_QUOTA_EXCEEDED", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse([{ errorCode: "REQUEST_LIMIT_EXCEEDED", message: "lim" }], 429),
    ) as unknown as typeof fetch;
    const client = makeClient(fetchImpl);
    await expect(
      client.createRecord("Barriers__c", { Type__c: "PA issue" }),
    ).rejects.toMatchObject({ code: "SF_QUOTA_EXCEEDED" });
  });
});

// SF_UPSTREAM_STATE_CHANGED (P1F-03b). Ownership / state changed mid-write —
// surfaces under both 400 (INVALID_CROSS_REFERENCE_KEY) and 404
// (ENTITY_IS_DELETED). Handlers re-render this as 409 UPSTREAM_STATE_CHANGED
// with `details.suggestedResolution` derived from `sfErrorCode`.
describe("SalesforceRestClient — SF_UPSTREAM_STATE_CHANGED mapping (P1F-03b)", () => {
  it("400 INVALID_CROSS_REFERENCE_KEY → SF_UPSTREAM_STATE_CHANGED with sfErrorCode preserved", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        [
          {
            errorCode: "INVALID_CROSS_REFERENCE_KEY",
            message: "foreign key not accessible",
          },
        ],
        400,
      ),
    ) as unknown as typeof fetch;
    const client = makeClient(fetchImpl);
    await expect(
      client.createRecord("IDW_Case_Note__c", {
        Program_Enrollment__c: "a015g00000ABCDxQAO",
      }),
    ).rejects.toMatchObject({
      code: "SF_UPSTREAM_STATE_CHANGED",
      sfErrorCode: "INVALID_CROSS_REFERENCE_KEY",
      statusCode: 400,
    });
  });

  it("404 ENTITY_IS_DELETED → SF_UPSTREAM_STATE_CHANGED with sfErrorCode preserved", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        [{ errorCode: "ENTITY_IS_DELETED", message: "entity is deleted" }],
        404,
      ),
    ) as unknown as typeof fetch;
    const client = makeClient(fetchImpl);
    await expect(
      client.createRecord("IDW_Case_Note__c", {
        Program_Enrollment__c: "a015g00000ABCDxQAO",
      }),
    ).rejects.toMatchObject({
      code: "SF_UPSTREAM_STATE_CHANGED",
      sfErrorCode: "ENTITY_IS_DELETED",
      statusCode: 404,
    });
  });
});
