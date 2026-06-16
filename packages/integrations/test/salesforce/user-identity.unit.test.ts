import { describe, expect, it, vi } from "vitest";

import type { SoqlQueryClient } from "../../src/salesforce/permission-set-role.js";
import type { SoqlQueryResponse } from "../../src/salesforce/rest-client.js";
import { fetchSalesforceUserIdentity } from "../../src/salesforce/user-identity.js";

const USER_ID = "0058K00000XYZAbQAO";

interface UserRow {
  readonly Name: string | null;
  readonly Email: string | null;
  readonly TimeZoneSidKey: string | null;
}

// Build a fake query client returning the given User rows.
function fakeClient(rows: ReadonlyArray<UserRow>): {
  client: SoqlQueryClient;
  query: ReturnType<typeof vi.fn>;
} {
  const query = vi.fn(
    async (): Promise<SoqlQueryResponse<unknown>> => ({
      totalSize: rows.length,
      done: true,
      records: rows,
    }),
  );
  return { client: { query } as SoqlQueryClient, query };
}

describe("fetchSalesforceUserIdentity", () => {
  it("resolves displayName / email / timezone from the User record", async () => {
    const { client, query } = fakeClient([
      {
        Name: "Marie Alcis",
        Email: "malcis@anthoshome.org",
        TimeZoneSidKey: "America/New_York",
      },
    ]);

    const identity = await fetchSalesforceUserIdentity(client, USER_ID);

    expect(identity).toEqual({
      displayName: "Marie Alcis",
      email: "malcis@anthoshome.org",
      timezone: "America/New_York",
    });
    // SOQL targets the User object, filtered by the validated, escaped Id.
    const soql = query.mock.calls[0]?.[0] as string;
    expect(soql).toContain("FROM User");
    expect(soql).toContain("Name, Email, TimeZoneSidKey");
    expect(soql).toContain(`Id = '${USER_ID}'`);
  });

  it("degrades a null field to an empty string", async () => {
    const { client } = fakeClient([
      { Name: null, Email: null, TimeZoneSidKey: null },
    ]);
    const identity = await fetchSalesforceUserIdentity(client, USER_ID);
    expect(identity).toEqual({ displayName: "", email: "", timezone: "" });
  });

  it("throws when the User query returns no row", async () => {
    const { client } = fakeClient([]);
    await expect(fetchSalesforceUserIdentity(client, USER_ID)).rejects.toThrow(
      /no row/,
    );
  });

  it("rejects a userId that is not a valid Salesforce Id (no SOQL issued)", async () => {
    const { client, query } = fakeClient([]);
    await expect(fetchSalesforceUserIdentity(client, "bad-id")).rejects.toThrow(
      /Salesforce User Id/,
    );
    expect(query).not.toHaveBeenCalled();
  });

  it("propagates a Salesforce query error", async () => {
    const client: SoqlQueryClient = {
      query: vi.fn(async () => {
        throw new Error("SF_NETWORK_TIMEOUT");
      }),
    };
    await expect(
      fetchSalesforceUserIdentity(client, USER_ID),
    ).rejects.toThrow(/SF_NETWORK_TIMEOUT/);
  });
});
