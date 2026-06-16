import { describe, expect, it, vi } from "vitest";

import {
  RoleResolutionError,
  parseSalesforceUserId,
  resolveRoleFromPermissionSet,
  type SoqlQueryClient,
} from "../../src/salesforce/permission-set-role.js";
import type { SoqlQueryResponse } from "../../src/salesforce/rest-client.js";

// A stand-in for the caller's role enum, low→high privilege.
const ROLES = ["SPECIALIST", "SUPERVISOR", "VP", "SYSTEM_ADMIN"] as const;
type Role = (typeof ROLES)[number];

const ROLE_MAP: Readonly<Record<string, Role>> = {
  Anthos_Aftercare_Specialist: "SPECIALIST",
  Anthos_Aftercare_Supervisor: "SUPERVISOR",
  Anthos_Aftercare_VP: "VP",
  Anthos_Aftercare_System_Admin: "SYSTEM_ADMIN",
};

const USER_ID = "0058K00000XYZAbQAO";
const IDENTITY_URL = `https://login.salesforce.com/id/00D8K000000ABCDUA0/${USER_ID}`;

// Build a fake query client returning the given perm-set names.
function fakeClient(permSetNames: ReadonlyArray<string | null>): {
  client: SoqlQueryClient;
  query: ReturnType<typeof vi.fn>;
} {
  const query = vi.fn(
    async (): Promise<SoqlQueryResponse<unknown>> => ({
      totalSize: permSetNames.length,
      done: true,
      records: permSetNames.map((Name) => ({ PermissionSet: { Name } })),
    }),
  );
  return { client: { query } as SoqlQueryClient, query };
}

describe("parseSalesforceUserId", () => {
  it("extracts the trailing User Id from an OAuth identity URL", () => {
    expect(parseSalesforceUserId(IDENTITY_URL)).toBe(USER_ID);
  });

  it("rejects a malformed URL", () => {
    expect(() => parseSalesforceUserId("not-a-url")).toThrow();
  });

  it("rejects an identity URL whose trailing segment is not a Salesforce Id", () => {
    expect(() =>
      parseSalesforceUserId("https://login.salesforce.com/id/00D/short"),
    ).toThrow(/Salesforce User Id/);
  });
});

describe("resolveRoleFromPermissionSet", () => {
  it("resolves the single matching permission set to its role", async () => {
    const { client, query } = fakeClient(["Anthos_Aftercare_Specialist"]);
    const role = await resolveRoleFromPermissionSet(
      client,
      USER_ID,
      ROLE_MAP,
      ROLES,
    );
    expect(role).toBe("SPECIALIST");
    // The SOQL filters PermissionSetAssignment by the validated AssigneeId.
    const soql = query.mock.calls[0]?.[0] as string;
    expect(soql).toContain("PermissionSetAssignment");
    expect(soql).toContain(`AssigneeId = '${USER_ID}'`);
  });

  it("ignores permission sets not in the role map", async () => {
    const { client } = fakeClient([
      "Some_Unrelated_Permission_Set",
      "Anthos_Aftercare_Supervisor",
      null,
    ]);
    const role = await resolveRoleFromPermissionSet(
      client,
      USER_ID,
      ROLE_MAP,
      ROLES,
    );
    expect(role).toBe("SUPERVISOR");
  });

  it("picks the highest-privilege role when several are assigned", async () => {
    const { client } = fakeClient([
      "Anthos_Aftercare_Specialist",
      "Anthos_Aftercare_VP",
      "Anthos_Aftercare_Supervisor",
    ]);
    const role = await resolveRoleFromPermissionSet(
      client,
      USER_ID,
      ROLE_MAP,
      ROLES,
    );
    expect(role).toBe("VP");
  });

  it("throws RoleResolutionError(PERMISSION_SET_MISSING) when no role perm set is held", async () => {
    const { client } = fakeClient(["Some_Unrelated_Permission_Set"]);
    const err = await resolveRoleFromPermissionSet(
      client,
      USER_ID,
      ROLE_MAP,
      ROLES,
    ).then(
      () => {
        throw new Error("expected a rejection");
      },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RoleResolutionError);
    expect((err as RoleResolutionError).reason).toBe("PERMISSION_SET_MISSING");
  });

  it("rejects a userId that is not a valid Salesforce Id (no SOQL issued)", async () => {
    const { client, query } = fakeClient([]);
    await expect(
      resolveRoleFromPermissionSet(client, "bad-id", ROLE_MAP, ROLES),
    ).rejects.toThrow(/Salesforce User Id/);
    expect(query).not.toHaveBeenCalled();
  });

  it("propagates a Salesforce query error", async () => {
    const client: SoqlQueryClient = {
      query: vi.fn(async () => {
        throw new Error("SF_NETWORK_TIMEOUT");
      }),
    };
    await expect(
      resolveRoleFromPermissionSet(client, USER_ID, ROLE_MAP, ROLES),
    ).rejects.toThrow(/SF_NETWORK_TIMEOUT/);
  });
});
