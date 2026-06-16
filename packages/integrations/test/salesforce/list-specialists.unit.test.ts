// Unit tests for the P1G-04 `listSpecialists` SOQL adapter (TR-SF-8). The
// cron worker uses this to enumerate the Users assigned to ANY of the tool's
// role permission sets, with each user's stored IANA timezone, so the
// nightly self-heal hard-refresh can fire at 02:00 in the specialist's
// local timezone.

import { describe, expect, it, vi } from "vitest";

import { listSpecialists } from "../../src/salesforce/list-specialists.js";
import type { SoqlQueryClient } from "../../src/salesforce/permission-set-role.js";
import type { SoqlQueryResponse } from "../../src/salesforce/rest-client.js";

interface AssignmentRow {
  readonly AssigneeId: string | null;
  readonly Assignee: {
    readonly Id: string | null;
    readonly IsActive: boolean | null;
    readonly TimeZoneSidKey: string | null;
  } | null;
}

function fakeClient(rows: ReadonlyArray<AssignmentRow>): {
  client: SoqlQueryClient;
  query: ReturnType<typeof vi.fn>;
} {
  const query = vi.fn(
    async (): Promise<SoqlQueryResponse<AssignmentRow>> => ({
      totalSize: rows.length,
      done: true,
      records: rows,
    }),
  );
  return { client: { query } as SoqlQueryClient, query };
}

const A = "0058K00000AAAAAAAA";
const B = "0058K00000BBBBBBBB";

describe("listSpecialists", () => {
  it("returns the active users assigned to ANY of the perm sets, with their TimeZoneSidKey", async () => {
    const { client, query } = fakeClient([
      {
        AssigneeId: A,
        Assignee: { Id: A, IsActive: true, TimeZoneSidKey: "America/New_York" },
      },
      {
        AssigneeId: B,
        Assignee: { Id: B, IsActive: true, TimeZoneSidKey: "America/Los_Angeles" },
      },
    ]);
    const result = await listSpecialists(client, [
      "Anthos_Aftercare_Specialist",
      "Anthos_Aftercare_Supervisor",
    ]);
    expect(result).toEqual([
      { specialistId: A, timezone: "America/New_York" },
      { specialistId: B, timezone: "America/Los_Angeles" },
    ]);
    const soql = query.mock.calls[0]?.[0] as string;
    expect(soql).toContain("PermissionSetAssignment");
    expect(soql).toContain(
      "PermissionSet.Name IN ('Anthos_Aftercare_Specialist','Anthos_Aftercare_Supervisor')",
    );
    expect(soql).toContain("Assignee.IsActive = true");
  });

  it("dedupes by user id when a user holds multiple matching perm sets", async () => {
    const { client } = fakeClient([
      {
        AssigneeId: A,
        Assignee: { Id: A, IsActive: true, TimeZoneSidKey: "America/New_York" },
      },
      {
        AssigneeId: A,
        Assignee: { Id: A, IsActive: true, TimeZoneSidKey: "America/New_York" },
      },
    ]);
    const result = await listSpecialists(client, ["Anthos_Aftercare_Specialist"]);
    expect(result).toEqual([
      { specialistId: A, timezone: "America/New_York" },
    ]);
  });

  it("returns empty timezone when TimeZoneSidKey is null (caller falls back to America/New_York)", async () => {
    const { client } = fakeClient([
      {
        AssigneeId: A,
        Assignee: { Id: A, IsActive: true, TimeZoneSidKey: null },
      },
    ]);
    const result = await listSpecialists(client, ["Anthos_Aftercare_Specialist"]);
    expect(result).toEqual([{ specialistId: A, timezone: "" }]);
  });

  it("returns [] (no round-trip) when the perm-set list is empty (FS-02 not-provisioned closed-fail)", async () => {
    const { client, query } = fakeClient([]);
    const result = await listSpecialists(client, []);
    expect(result).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it("SOQL-escapes a perm-set name with a stray quote (defensive — operator config, not user input)", async () => {
    const { client, query } = fakeClient([]);
    await listSpecialists(client, ["weird'name"]);
    const soql = query.mock.calls[0]?.[0] as string;
    expect(soql).toContain("'weird\\'name'");
  });
});
