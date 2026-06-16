// P1C-03: REST-polling fallback for Salesforce CDC (slaughter list item 17).
// The Production gRPC Pub/Sub subscriber (SAD §12.2, ADR-06) replaces this in
// Production. The contract here is intentionally narrow — one SOQL per polled
// SObject — so the Demo worker (`packages/api/src/workers/sf-cdc-poll.ts`)
// can share its cycle orchestration with the future gRPC subscriber by
// swapping only the event source.
//
// Mechanics: per cycle, for each canonical SObject (TRD INT-SF-3 v1.8), issue
// `SELECT Id, OwnerId, SystemModstamp FROM <object> WHERE SystemModstamp > :since
//  ORDER BY SystemModstamp ASC LIMIT N`. Records are returned in commit order.
// If the result hits the LIMIT, the cycle is marked PARTIAL — the worker
// advances the cursor to the last observed SystemModstamp and the next cycle
// picks up where this one stopped (commit-order on SystemModstamp guarantees
// no event loss).
//
// `:since` is the ISO-8601 SystemModstamp stored in the cursor map. SOQL
// SystemModstamp comparisons accept ISO-8601 literals with `T` and `Z` —
// validated below before interpolation so a malformed cursor cannot inject.

import type { SalesforceRestClient } from "./rest-client.js";

// LIMIT for each per-object poll. 2000 is the SF SOQL governor cap on a
// single response — going past it would trigger pagination and TR-SF-2's
// round-trip budget, neither of which fits the 30s polling envelope. When
// a poll returns exactly 2000 rows we surface `partial=true` so the worker
// can flag the cycle and keep advancing through the backlog.
export const DEFAULT_POLL_LIMIT = 2000;

// SystemModstamp ISO-8601 with a trailing Z (UTC). Matches both Date.toISOString()
// output and Salesforce's own SystemModstamp serialization on REST reads.
// Bounded quantifiers everywhere — fixed-length date / time segments and an
// optional fractional-second group of 1..3 digits — so the match is linear
// in input length (no catastrophic-backtracking surface).
// eslint-disable-next-line security/detect-unsafe-regex
const ISO_8601_Z_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

// Salesforce API names are 1–40 chars, alphanumeric + underscores, optionally
// ending in `__c` for custom objects. Validated to lock interpolation.
const SF_API_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,40}$/;

export interface CdcChangeRecord {
  // Salesforce 18-char Id of the changed record.
  readonly Id: string;
  // Owning specialist's User Id. Some objects (Incident, Barriers) may not
  // expose OwnerId on every record shape — null when absent. The worker
  // dedupes only on non-null OwnerIds.
  readonly OwnerId: string | null;
  // ISO-8601 with trailing Z. Cursor advances to the LAST value observed.
  readonly SystemModstamp: string;
}

export interface PollObjectChangesInput {
  // Salesforce API name, e.g., `Case_Note__c`. Validated against
  // SF_API_NAME_PATTERN — caller errors out if the canonical list drifts.
  readonly object: string;
  // ISO-8601 cursor. `null` is treated as "first run for this object";
  // the worker falls back to a recent window per its recovery-mode policy.
  readonly sinceIso: string | null;
  // Override the default 2000 LIMIT for testing or governor-tight runs.
  readonly limit?: number;
}

export interface PollObjectChangesResult {
  readonly object: string;
  readonly records: ReadonlyArray<CdcChangeRecord>;
  // True iff `records.length === limit` — the SOQL likely truncated the
  // backlog at the governor boundary. The worker keeps cycling until a
  // partial cycle becomes a full one.
  readonly partial: boolean;
  // The advancing cursor for this object after the cycle: the SystemModstamp
  // of the last record returned, or the input `sinceIso` if zero records.
  // Null is propagated when both are null (first-run, empty result).
  readonly nextCursorIso: string | null;
}

// Issues one SOQL against `object` for `SystemModstamp > :since`. Returns the
// records in commit order plus the advancing cursor. The caller (the worker)
// is responsible for the OwnerId → invalidation dispatch and for persisting
// the new cursor in `cdc_health.subscription_states`.
export async function pollObjectChanges(
  client: SalesforceRestClient,
  input: PollObjectChangesInput,
): Promise<PollObjectChangesResult> {
  if (!SF_API_NAME_PATTERN.test(input.object)) {
    throw new Error(
      `pollObjectChanges: object name does not match Salesforce API name pattern`,
    );
  }
  if (input.sinceIso !== null && !ISO_8601_Z_PATTERN.test(input.sinceIso)) {
    throw new Error(
      "pollObjectChanges: sinceIso must be ISO-8601 with trailing Z",
    );
  }
  const limit = input.limit ?? DEFAULT_POLL_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0 || limit > DEFAULT_POLL_LIMIT) {
    throw new Error(
      `pollObjectChanges: limit must be a positive integer ≤ ${DEFAULT_POLL_LIMIT}`,
    );
  }

  // SOQL SystemModstamp comparisons accept an ISO-8601 datetime literal
  // unquoted. We've validated the cursor matches the strict regex above so
  // there is no string-injection surface. On a null cursor we omit the WHERE
  // — the LIMIT bounds the response and the next cycle's cursor will advance.
  const whereClause =
    input.sinceIso === null
      ? ""
      : ` WHERE SystemModstamp > ${input.sinceIso}`;
  const soql = `SELECT Id, OwnerId, SystemModstamp FROM ${input.object}${whereClause} ORDER BY SystemModstamp ASC LIMIT ${limit}`;

  const response = await client.query<CdcChangeRecord>(soql);
  const records = response.records;
  const partial = records.length >= limit;
  const lastRecord = records.length > 0 ? records[records.length - 1] : undefined;
  const nextCursorIso = lastRecord !== undefined
    ? lastRecord.SystemModstamp
    : input.sinceIso;

  return {
    object: input.object,
    records,
    partial,
    nextCursorIso,
  };
}
