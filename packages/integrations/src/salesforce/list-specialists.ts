// P1G-04 / TR-SF-8: enumerate the Salesforce Users assigned to ANY of the
// tool's role permission sets, with each user's stored IANA timezone. The
// nightly self-heal hard-refresh cron iterates this list and fires per
// specialist at 02:00 in their local timezone — Salesforce stays system of
// record (Immutable #1) for "who is a specialist." No participant data is
// read; only staff Ids + the staff TimeZoneSidKey, both already visible to
// the embedding Salesforce page.
//
// The caller supplies the permission-set name set so this adapter stays
// generic — the four tool role perm sets are owned by Anthos's SF admin
// (Erik); the caller resolves them from `ANTHOS_ROLE_PERMISSION_SETS` (the
// same env var the auth callback reads, P1B-02 / `callback-config.ts`). When
// Erik has not yet provisioned the perm sets, the SOQL legitimately returns
// zero rows and the cron is a no-op — the same closed-fail posture the
// `/auth/callback` resolver already takes (FS-02 "not provisioned").

import type { SoqlQueryClient } from "./permission-set-role.js";
import { escapeSoqlString } from "./soql.js";

// One specialist the cron will consider for refresh. `timezone` is the
// IANA-style zone (`America/New_York`); empty when the SF User row has no
// `TimeZoneSidKey` (the cron's caller falls back to `America/New_York` per
// ticket §Notes).
export interface SalesforceSpecialist {
  readonly specialistId: string;
  readonly timezone: string;
}

// One `PermissionSetAssignment` row — only the assignee Id and the assignee's
// active-flag + timezone are read (the perm-set membership is the filter, not
// the projection).
interface AssignmentRow {
  readonly AssigneeId: string | null;
  readonly Assignee: {
    readonly Id: string | null;
    readonly IsActive: boolean | null;
    readonly TimeZoneSidKey: string | null;
  } | null;
}

// SOQL escape + quote a list of perm-set API names for an `IN (...)` clause.
// `permissionSetNames` is operator config (env-var driven), so escaping is
// defensive: a name with a stray quote would corrupt the query, not exfil
// data, but tightening this here keeps the adapter audited the same way the
// `WHERE Id = '...'` interpolations are.
function buildPermSetInClause(permissionSetNames: ReadonlyArray<string>): string {
  return permissionSetNames
    .map((name) => `'${escapeSoqlString(name)}'`)
    .join(",");
}

// Enumerate the active SF Users assigned to ANY perm set in
// `permissionSetNames`, with each user's `TimeZoneSidKey`. Dedupes by user Id
// (a specialist who holds multiple role perm sets — e.g., the ones the auth
// resolver promotes to SUPERVISOR — appears once). An empty perm-set list
// resolves to `[]` without a round-trip; this is the no-op posture when the
// caller's `ANTHOS_ROLE_PERMISSION_SETS` is unpopulated or all the tool
// perm sets are unprovisioned.
export async function listSpecialists(
  client: SoqlQueryClient,
  permissionSetNames: ReadonlyArray<string>,
): Promise<ReadonlyArray<SalesforceSpecialist>> {
  if (permissionSetNames.length === 0) {
    return [];
  }
  const inClause = buildPermSetInClause(permissionSetNames);
  const soql =
    "SELECT AssigneeId, Assignee.Id, Assignee.IsActive, Assignee.TimeZoneSidKey " +
    "FROM PermissionSetAssignment " +
    `WHERE PermissionSet.Name IN (${inClause}) ` +
    "AND Assignee.IsActive = true";

  const result = await client.query<AssignmentRow>(soql);

  // Dedupe — the first seen TZ for each Id wins; SF guarantees one User row
  // so all rows for the same Id carry the same TimeZoneSidKey, but using a
  // Map makes that explicit.
  const seen = new Map<string, SalesforceSpecialist>();
  for (const row of result.records) {
    const id = row.AssigneeId ?? row.Assignee?.Id ?? null;
    if (id === null || id.length === 0) continue;
    if (row.Assignee?.IsActive === false) continue;
    if (seen.has(id)) continue;
    seen.set(id, {
      specialistId: id,
      timezone: row.Assignee?.TimeZoneSidKey ?? "",
    });
  }
  return [...seen.values()];
}
