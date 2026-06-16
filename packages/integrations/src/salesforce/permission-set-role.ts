import type { SoqlQueryResponse } from "./rest-client.js";
import { assertSalesforceId, escapeSoqlString } from "./soql.js";

// P1B-02 / TR-AUTH-8: resolve a specialist's tool role from their Salesforce
// custom permission-set assignments, evaluated at session start (E-02). The
// `/auth/callback` handler runs this with the per-specialist access token from
// the code exchange.
//
// This module is deliberately role-type-agnostic — it is generic over the
// caller's role enum and privilege order — so `@anthos/integrations` stays a
// leaf package (no `@anthos/auth` edge). Role semantics live with the caller.

// The slice of `SalesforceRestClient` the resolver needs — a minimal seam so a
// unit test can inject a fake without constructing a real HTTP client.
// `SalesforceRestClient` structurally satisfies this; a real instance is
// passed at the `/auth/callback` call site.
export interface SoqlQueryClient {
  query<T>(soql: string): Promise<SoqlQueryResponse<T>>;
}

export type RoleResolutionFailureReason = "PERMISSION_SET_MISSING";

// Thrown when the Salesforce user holds none of the tool's role permission
// sets — FS-02 "tool access not provisioned" / EC-02. The caller maps this to
// an `auth.failure` audit row + the API §9.2 `AUTH_PERMISSION_SET_MISSING`
// failure path.
export class RoleResolutionError extends Error {
  readonly reason: RoleResolutionFailureReason;

  constructor(reason: RoleResolutionFailureReason, message: string) {
    super(message);
    this.name = "RoleResolutionError";
    this.reason = reason;
  }
}

// One `PermissionSetAssignment` row — only the parent perm-set name is read.
interface PermissionSetAssignmentRow {
  readonly PermissionSet: { readonly Name: string | null } | null;
}

// Parse the Salesforce User Id from an OAuth identity URL
// (`https://login.salesforce.com/id/<orgId>/<userId>`). Throws when the URL is
// malformed or the trailing segment is not a valid Salesforce Id.
export function parseSalesforceUserId(identityUrl: string): string {
  let pathname: string;
  try {
    pathname = new URL(identityUrl).pathname;
  } catch {
    throw new Error("Salesforce identity URL is not a valid URL");
  }
  const userId = pathname.split("/").filter((s) => s.length > 0).pop() ?? "";
  assertSalesforceId(userId, "Salesforce User Id");
  return userId;
}

// Resolve the single tool role for `userId` from their `PermissionSetAssignment`
// rows. `roleMap` maps a Salesforce PermissionSet API name → the caller's role
// value; `privilegeOrder` is the caller's role values low→high — when a user
// holds several role permission sets, the highest-privilege one wins
// deterministically (a specialist who is also a supervisor resolves to
// supervisor). Throws `RoleResolutionError("PERMISSION_SET_MISSING")` when the
// user holds none of the tool's role permission sets.
export async function resolveRoleFromPermissionSet<R extends string>(
  client: SoqlQueryClient,
  userId: string,
  roleMap: Readonly<Record<string, R>>,
  privilegeOrder: readonly R[],
): Promise<R> {
  // Defensive: `userId` is interpolated into SOQL — validate, then escape.
  assertSalesforceId(userId, "Salesforce User Id");
  const soql =
    "SELECT PermissionSet.Name FROM PermissionSetAssignment " +
    `WHERE AssigneeId = '${escapeSoqlString(userId)}'`;

  const result =
    await client.query<PermissionSetAssignmentRow>(soql);

  // Build the lookup as a Map — a plain-object index on an attacker-influenced
  // key trips the object-injection lint, and a Map is the correct tool anyway.
  const lookup = new Map<string, R>(Object.entries(roleMap));

  const matched: R[] = [];
  for (const row of result.records) {
    const name = row.PermissionSet?.Name;
    if (typeof name === "string") {
      const role = lookup.get(name);
      if (role !== undefined) {
        matched.push(role);
      }
    }
  }

  if (matched.length === 0) {
    throw new RoleResolutionError(
      "PERMISSION_SET_MISSING",
      "the Salesforce user holds none of the tool's role permission sets",
    );
  }

  return matched.reduce((highest, role) =>
    privilegeOrder.indexOf(role) > privilegeOrder.indexOf(highest)
      ? role
      : highest,
  );
}
