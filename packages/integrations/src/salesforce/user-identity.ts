// P1B-05 / TR-AUTH-8: read a specialist's own identity from their Salesforce
// User record, evaluated at session start (E-02). `/auth/callback` runs this
// with the per-specialist access token from the code exchange, alongside
// `resolveRoleFromPermissionSet`; the resolved identity is persisted on the
// session row so `GET /api/v1/me` (E-05) is a pure DB read.
//
// The fields are the SIGNED-IN SPECIALIST's own — staff identity, already
// visible in the embedding Salesforce page — never participant data.

import type { SoqlQueryClient } from "./permission-set-role.js";
import { assertSalesforceId, escapeSoqlString } from "./soql.js";

// The specialist identity surfaced by `GET /me` (API §7.2.5).
export interface SalesforceUserIdentity {
  // `User.Name` — the specialist's display name.
  readonly displayName: string;
  // `User.Email` — the specialist's work email.
  readonly email: string;
  // `User.TimeZoneSidKey` — an IANA-style zone (e.g. `America/New_York`).
  readonly timezone: string;
}

// One `User` row — only the three identity fields are read.
interface UserRow {
  readonly Name: string | null;
  readonly Email: string | null;
  readonly TimeZoneSidKey: string | null;
}

// Resolve `displayName` / `email` / `timezone` for `userId` from the Salesforce
// `User` object. The caller has just completed the OAuth code exchange for this
// user, so the record always exists — a missing row is an upstream anomaly and
// throws (the `/auth/callback` caller maps it to a transient failure, never a
// silent empty identity). A null individual field degrades to an empty string:
// `Name` / `Email` are required in Salesforce, so this is purely defensive.
export async function fetchSalesforceUserIdentity(
  client: SoqlQueryClient,
  userId: string,
): Promise<SalesforceUserIdentity> {
  // Defensive: `userId` is interpolated into SOQL — validate, then escape.
  assertSalesforceId(userId, "Salesforce User Id");
  const soql =
    "SELECT Name, Email, TimeZoneSidKey FROM User " +
    `WHERE Id = '${escapeSoqlString(userId)}'`;

  const result = await client.query<UserRow>(soql);
  const row = result.records[0];
  if (row === undefined) {
    throw new Error(
      "Salesforce User query returned no row for the authenticated user",
    );
  }

  return {
    displayName: row.Name ?? "",
    email: row.Email ?? "",
    timezone: row.TimeZoneSidKey ?? "",
  };
}
