// Warm-read displayName hydration (P1H-13a).
//
// `stripPiiForCache` (dto.ts) nulls `displayName` on every cache write — the
// `caseload_cache` payload contract and Immutable #1 forbid participant PII at
// rest. Warm-cache reads therefore return `displayName: null`, and without a
// re-hydration step the SPA falls back to the 18-char `participantId`.
//
// This module re-attaches names on warm reads. Two layers:
//   1. A process-local Map cache keyed by participantId (TTL: 10 minutes).
//      RAM only — never crosses into postgres, so Immutable #1 is preserved.
//      On Vercel the cache survives within a Function instance; cold starts
//      see an empty Map. The pattern is substrate-portable (a Production
//      Fargate task preserves the same in-process model).
//   2. A single bulk SOQL backfill per request for the cache misses:
//      `SELECT Id, Contact__r.Name FROM IDW_Program_Enrollment__c WHERE Id IN (...)`
//      Misses are batched at 200 IDs per query (SF governor-limit floor).
//
// Cold-path responses already carry names (set by `buildCaseloadItem`); calling
// this hydrate is a no-op for them. Routing both paths through the same step
// keeps the response shape uniform.

import {
  SalesforceRestClient,
  buildIdInClause,
  type SalesforceAuth,
} from "@anthos/integrations";

import { selectSalesforceAuth } from "../salesforce/select-auth.js";

import type { CaseloadBody } from "./dto.js";

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_BATCH_SIZE = 200;

interface CacheEntry {
  readonly name: string | null;
  readonly expiresAt: number;
}

// One Map per process. Exported only for test reset; production code reads
// through the default options path.
export const moduleCache = new Map<string, CacheEntry>();

interface EnrollmentNameRow {
  Id: string;
  Contact__r: { Name: string | null } | null;
}

export type RunNameQuery = (
  ids: ReadonlyArray<string>,
) => Promise<ReadonlyArray<EnrollmentNameRow>>;

export interface HydrateDisplayNamesOptions {
  readonly now?: () => number;
  readonly ttlMs?: number;
  readonly batchSize?: number;
  readonly cache?: Map<string, CacheEntry>;
  readonly runQuery?: RunNameQuery;
}

// Returns a new CaseloadBody with `displayName` populated where possible.
// No-op when every item already has a non-null name. Pure RAM/SF; no DB I/O.
export async function hydrateDisplayNames(
  body: CaseloadBody,
  options: HydrateDisplayNamesOptions = {},
): Promise<CaseloadBody> {
  const cache = options.cache ?? moduleCache;
  const nowMs = (options.now ?? (() => Date.now()))();
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;

  const idsNeedingName = body.items
    .filter((item) => item.displayName === null)
    .map((item) => item.participantId);

  if (idsNeedingName.length === 0) return body;

  const resolved = new Map<string, string | null>();
  const misses: string[] = [];
  for (const id of idsNeedingName) {
    const entry = cache.get(id);
    if (entry !== undefined && entry.expiresAt > nowMs) {
      resolved.set(id, entry.name);
    } else {
      misses.push(id);
    }
  }

  if (misses.length > 0) {
    const runQuery = options.runQuery ?? defaultRunQuery;
    for (let i = 0; i < misses.length; i += batchSize) {
      const batch = misses.slice(i, i + batchSize);
      const rows = await runQuery(batch);
      const fetched = new Map<string, string | null>();
      for (const row of rows) {
        const name = row.Contact__r?.Name ?? null;
        fetched.set(row.Id, name);
        cache.set(row.Id, { name, expiresAt: nowMs + ttlMs });
        resolved.set(row.Id, name);
      }
      // Cache a not-found result as `null` so a deleted/inaccessible row does
      // not re-query SF on every request for the rest of the TTL window.
      for (const id of batch) {
        if (!fetched.has(id)) {
          cache.set(id, { name: null, expiresAt: nowMs + ttlMs });
          resolved.set(id, null);
        }
      }
    }
  }

  const items = body.items.map((item) => {
    if (item.displayName !== null) return item;
    const name = resolved.get(item.participantId);
    if (name === undefined || name === null) return item;
    return { ...item, displayName: name };
  });

  return { ...body, items };
}

async function defaultRunQuery(
  ids: ReadonlyArray<string>,
): Promise<ReadonlyArray<EnrollmentNameRow>> {
  const auth: SalesforceAuth = selectSalesforceAuth();
  const client = new SalesforceRestClient({ auth });
  const inClause = buildIdInClause(ids);
  const soql = `SELECT Id, Contact__r.Name FROM IDW_Program_Enrollment__c WHERE Id IN (${inClause})`;
  const response = await client.query<EnrollmentNameRow>(soql);
  return response.records;
}
