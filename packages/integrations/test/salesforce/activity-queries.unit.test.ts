import { describe, expect, it, vi } from "vitest";

import {
  queryCaseloadActivityRecords,
  queryOwnedEnrollments,
} from "../../src/salesforce/activity-queries.js";
import { SalesforceRestClient } from "../../src/salesforce/rest-client.js";
import { SalesforceError, type SalesforceAuth } from "../../src/salesforce/types.js";

const STATIC_AUTH: SalesforceAuth = {
  getAccessToken: () => Promise.resolve("FAKE_TOKEN"),
  getInstanceUrl: () => Promise.resolve("https://fake.my.salesforce.com"),
};

const OWNER_ID = "005U800000ABCDEFGH";
const PE_A = "a1kU800000pjmA1IAI";
const PE_B = "a1kU800000pjmB2IAI";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Captures each fetch call's URL + decoded SOQL so tests can assert query shape.
function makeCapturingFetch(responses: ReadonlyArray<Response>): {
  fetchImpl: typeof fetch;
  urls: string[];
  bodies: unknown[];
} {
  let i = 0;
  const urls: string[] = [];
  const bodies: unknown[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    urls.push(String(url));
    if (init?.body !== undefined) bodies.push(JSON.parse(String(init.body)));
    const r = responses[i++];
    if (r === undefined) throw new Error(`no response queued for call ${i}`);
    return r;
  }) as unknown as typeof fetch;
  return { fetchImpl, urls, bodies };
}

function decodeQuery(url: string): string {
  const q = new URL(url).searchParams.get("q");
  return q ?? "";
}

describe("queryOwnedEnrollments", () => {
  it("queries the caseload membership predicate and maps id + name", async () => {
    const { fetchImpl, urls } = makeCapturingFetch([
      jsonResponse({
        totalSize: 2,
        done: true,
        records: [
          { Id: PE_A, Contact__r: { Name: "Casey Rivera" } },
          { Id: PE_B, Contact__r: null },
        ],
      }),
    ]);
    const client = new SalesforceRestClient({ auth: STATIC_AUTH, fetchImpl });

    const result = await queryOwnedEnrollments(OWNER_ID, client);

    const soql = decodeQuery(urls[0]!);
    expect(soql).toContain("FROM IDW_Program_Enrollment__c");
    expect(soql).toContain(`Aftercare_Owner__c = '${OWNER_ID}'`);
    expect(soql).toContain("RecordType.DeveloperName = 'Matching'");
    expect(soql).toContain("Inactive__c = false");
    expect(soql).toContain("Contact__r.Name");
    expect(result).toEqual([
      { id: PE_A, name: "Casey Rivera" },
      { id: PE_B, name: null },
    ]);
  });
});

describe("queryCaseloadActivityRecords", () => {
  it("short-circuits with no SF call when there are no participants", async () => {
    const { fetchImpl, urls } = makeCapturingFetch([]);
    const client = new SalesforceRestClient({ auth: STATIC_AUTH, fetchImpl });

    const result = await queryCaseloadActivityRecords({
      peIds: [],
      fromDate: "2026-06-01",
      toDate: "2026-06-30",
      restClient: client,
    });

    expect(result).toEqual({ caseNotes: [], sms: [] });
    expect(urls).toHaveLength(0);
  });

  it("builds metadata-only case-note + SMS sub-queries in one composite batch", async () => {
    const { fetchImpl, urls, bodies } = makeCapturingFetch([
      jsonResponse({
        hasErrors: false,
        results: [
          {
            statusCode: 200,
            result: {
              totalSize: 1,
              done: true,
              records: [
                {
                  Id: "a1dU800000C516DIAR",
                  Program_Enrollment__c: PE_A,
                  Type__c: "Stability Meeting",
                  Status__c: "Scheduled",
                  Contact_Type__c: "In Person",
                  Service_Date__c: "2026-06-15",
                },
              ],
            },
          },
          {
            statusCode: 200,
            result: {
              totalSize: 1,
              done: true,
              records: [
                {
                  Id: "a2xU800000Z9999IAR",
                  Program_Enrollment__c: PE_B,
                  Mogli_SMS__Direction__c: "Outgoing",
                  Mogli_SMS__Status__c: "Queued",
                  CreatedDate: "2026-06-10T14:00:00.000+0000",
                },
              ],
            },
          },
        ],
      }),
    ]);
    const client = new SalesforceRestClient({ auth: STATIC_AUTH, fetchImpl });

    const result = await queryCaseloadActivityRecords({
      peIds: [PE_A, PE_B],
      fromDate: "2026-06-01",
      toDate: "2026-06-30",
      restClient: client,
    });

    // One composite-batch round-trip.
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("/composite/batch");
    const batch = bodies[0] as {
      batchRequests: ReadonlyArray<{ url: string }>;
    };
    const caseNoteSoql = decodeURIComponent(batch.batchRequests[0]!.url);
    const smsSoql = decodeURIComponent(batch.batchRequests[1]!.url);

    // Case-note query: PE IN-clause + Service_Date bounds, NO body field.
    expect(caseNoteSoql).toContain("FROM IDW_Case_Note__c");
    expect(caseNoteSoql).toContain(`Program_Enrollment__c IN ('${PE_A}','${PE_B}')`);
    expect(caseNoteSoql).toContain("Service_Date__c >= 2026-06-01");
    expect(caseNoteSoql).toContain("Service_Date__c <= 2026-06-30");
    // No note body in the SELECT list (the `Case_Note__c` field — distinct from
    // the `IDW_Case_Note__c` object name).
    const caseNoteSelect = caseNoteSoql.split(" FROM ")[0]!;
    expect(caseNoteSelect).not.toContain("Case_Note__c");
    // SMS query: CreatedDate datetime bounds, NO message body.
    expect(smsSoql).toContain("FROM Mogli_SMS__SMS__c");
    expect(smsSoql).toContain("CreatedDate >= 2026-06-01T00:00:00Z");
    expect(smsSoql).toContain("CreatedDate <= 2026-06-30T23:59:59Z");
    expect(smsSoql).not.toContain("Mogli_SMS__Message__c"); // no SMS body

    expect(result.caseNotes).toHaveLength(1);
    expect(result.caseNotes[0]?.Type__c).toBe("Stability Meeting");
    expect(result.sms).toHaveLength(1);
    expect(result.sms[0]?.Mogli_SMS__Status__c).toBe("Queued");
  });

  it("rejects a non-ISO date before issuing a query", async () => {
    const { fetchImpl, urls } = makeCapturingFetch([]);
    const client = new SalesforceRestClient({ auth: STATIC_AUTH, fetchImpl });

    await expect(
      queryCaseloadActivityRecords({
        peIds: [PE_A],
        fromDate: "06/01/2026",
        toDate: "2026-06-30",
        restClient: client,
      }),
    ).rejects.toBeInstanceOf(SalesforceError);
    expect(urls).toHaveLength(0);
  });

  it("maps a composite-batch error to a SalesforceError", async () => {
    const { fetchImpl } = makeCapturingFetch([
      jsonResponse({
        hasErrors: true,
        results: [
          { statusCode: 400, result: { message: "MALFORMED_QUERY" } },
          { statusCode: 200, result: { totalSize: 0, done: true, records: [] } },
        ],
      }),
    ]);
    const client = new SalesforceRestClient({ auth: STATIC_AUTH, fetchImpl });

    await expect(
      queryCaseloadActivityRecords({
        peIds: [PE_A],
        fromDate: "2026-06-01",
        toDate: "2026-06-30",
        restClient: client,
      }),
    ).rejects.toBeInstanceOf(SalesforceError);
  });
});
