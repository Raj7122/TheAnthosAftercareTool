import { describe, expect, it, vi } from "vitest";

import { pollObjectChanges } from "../../src/salesforce/cdc-poll.js";
import { SalesforceRestClient } from "../../src/salesforce/rest-client.js";
import type { SalesforceAuth } from "../../src/salesforce/types.js";

const AUTH: SalesforceAuth = {
  getAccessToken: () => Promise.resolve("FAKE_TOKEN"),
  getInstanceUrl: () => Promise.resolve("https://fake.my.salesforce.com"),
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function client(records: unknown[]) {
  const fetchImpl = vi.fn<typeof fetch>(async () =>
    jsonResponse({ totalSize: records.length, done: true, records }),
  );
  const rest = new SalesforceRestClient({
    auth: AUTH,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  return { rest, fetchImpl };
}

describe("pollObjectChanges (P1C-03 CDC REST fallback)", () => {
  it("issues a SOQL with WHERE SystemModstamp > :since when a cursor exists", async () => {
    const { rest, fetchImpl } = client([]);
    await pollObjectChanges(rest, {
      object: "Case_Note__c",
      sinceIso: "2026-05-22T12:00:00.000Z",
    });
    const firstCall = fetchImpl.mock.calls[0];
    if (firstCall === undefined) throw new Error("expected one fetch call");
    const url = String(firstCall[0]);
    expect(url).toContain(encodeURIComponent("SELECT Id, OwnerId, SystemModstamp FROM Case_Note__c"));
    expect(url).toContain(encodeURIComponent("WHERE SystemModstamp > 2026-05-22T12:00:00.000Z"));
    expect(url).toContain(encodeURIComponent("ORDER BY SystemModstamp ASC"));
  });

  it("omits the WHERE clause on a null cursor (first run)", async () => {
    const { rest, fetchImpl } = client([]);
    await pollObjectChanges(rest, { object: "Case_Note__c", sinceIso: null });
    const firstCall = fetchImpl.mock.calls[0];
    if (firstCall === undefined) throw new Error("expected one fetch call");
    const url = String(firstCall[0]);
    expect(url).not.toContain("WHERE");
  });

  it("advances nextCursorIso to the last record's SystemModstamp", async () => {
    const { rest } = client([
      { Id: "a01", OwnerId: "005A", SystemModstamp: "2026-05-22T12:01:00.000Z" },
      { Id: "a02", OwnerId: "005B", SystemModstamp: "2026-05-22T12:02:00.000Z" },
    ]);
    const result = await pollObjectChanges(rest, {
      object: "Case_Note__c",
      sinceIso: "2026-05-22T12:00:00.000Z",
    });
    expect(result.nextCursorIso).toBe("2026-05-22T12:02:00.000Z");
    expect(result.records).toHaveLength(2);
    expect(result.partial).toBe(false);
  });

  it("returns nextCursorIso = sinceIso when zero records", async () => {
    const { rest } = client([]);
    const result = await pollObjectChanges(rest, {
      object: "Case_Note__c",
      sinceIso: "2026-05-22T12:00:00.000Z",
    });
    expect(result.nextCursorIso).toBe("2026-05-22T12:00:00.000Z");
    expect(result.records).toHaveLength(0);
    expect(result.partial).toBe(false);
  });

  it("marks the result partial when the LIMIT was hit", async () => {
    const records = Array.from({ length: 5 }, (_, i) => ({
      Id: `a0${i}`,
      OwnerId: "005A",
      SystemModstamp: `2026-05-22T12:0${i}:00.000Z`,
    }));
    const { rest } = client(records);
    const result = await pollObjectChanges(rest, {
      object: "Case_Note__c",
      sinceIso: null,
      limit: 5,
    });
    expect(result.partial).toBe(true);
    expect(result.nextCursorIso).toBe("2026-05-22T12:04:00.000Z");
  });

  it("rejects an invalid object name", async () => {
    const { rest } = client([]);
    await expect(
      pollObjectChanges(rest, { object: "1Bad Name; DROP", sinceIso: null }),
    ).rejects.toThrow(/Salesforce API name/);
  });

  it("rejects a malformed cursor (no injection surface)", async () => {
    const { rest } = client([]);
    await expect(
      pollObjectChanges(rest, {
        object: "Case_Note__c",
        sinceIso: "2026-05-22 12:00:00",
      }),
    ).rejects.toThrow(/ISO-8601/);
  });

  it("rejects an out-of-range limit", async () => {
    const { rest } = client([]);
    await expect(
      pollObjectChanges(rest, {
        object: "Case_Note__c",
        sinceIso: null,
        limit: 5000,
      }),
    ).rejects.toThrow(/positive integer/);
  });
});
