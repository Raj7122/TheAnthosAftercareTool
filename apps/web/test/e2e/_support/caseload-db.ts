// Test-DB helpers for the P1C-07 caseload perf E2E. Sibling to `db.ts` (whose
// auth-table helpers are unchanged); kept in its own module so the perf spec's
// imports are scoped and the auth-table helpers don't drift through grow-by-
// concatenation.
//
// These wrap the existing `caseload_cache` repository semantics (P1C-02) at
// the raw-SQL level rather than re-importing `@anthos/persistence` so the
// test process and the BFF under test stay decoupled — the spec speaks SQL
// to the same `DEMO_POSTGRES_URL` the BFF writes to, mirroring `db.ts`.

import pg from "pg";

import { FIXTURE_CONFIG_VERSION, type FixtureCaseloadBody, type QueueId } from "./caseload-fixtures.js";
import { POSTGRES_URL, SPECIALIST_ID } from "./constants.js";

function newClient(): pg.Client {
  return new pg.Client({
    connectionString: POSTGRES_URL,
    ssl: POSTGRES_URL.includes("sslmode=disable") ? false : { rejectUnauthorized: false },
  });
}

async function withClient<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = newClient();
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

// Seeds one warm `caseload_cache` row per queue. The four bodies share their
// `queueCounts`, so a `?queue=X` read returns the same counts regardless of
// which queue is hit first — mirroring the cold-path write-through in
// `get-caseload.ts:288` that writes all four queues' bodies in one pass.
//
// `freshness_window_seconds` is set generously (600s) so the warm test cannot
// accidentally race past the 60s default while Playwright is doing its
// own setup — the perf assertion is the only signal that matters.
export async function seedCaseloadCache(
  bodiesByQueue: Record<QueueId, FixtureCaseloadBody>,
  specialistId: string = SPECIALIST_ID,
): Promise<void> {
  await withClient(async (client) => {
    for (const [queueId, body] of Object.entries(bodiesByQueue) as Array<
      [QueueId, FixtureCaseloadBody]
    >) {
      await client.query(
        `INSERT INTO caseload_cache (
           specialist_id, queue_id, config_version, payload,
           freshness_window_seconds, last_refreshed_at
         )
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (specialist_id, queue_id, config_version) DO UPDATE
           SET payload = EXCLUDED.payload,
               freshness_window_seconds = EXCLUDED.freshness_window_seconds,
               last_refreshed_at = NOW()`,
        [
          specialistId,
          queueId,
          FIXTURE_CONFIG_VERSION,
          JSON.stringify(body),
          600,
        ],
      );
    }
  });
}

// CDC invalidation stand-in. The real P1C-03 worker calls
// `invalidateCaseloadCache(db, { kind: "specialist", specialistId })` on the
// OwnerId of any changed object — direct DELETE mirrors that contract, which
// keeps the perf test deterministic (the worker has its own unit tests in
// packages/api/test/workers).
export async function clearCaseloadCache(
  specialistId: string = SPECIALIST_ID,
): Promise<number> {
  return withClient(async (client) => {
    const result = await client.query(
      "DELETE FROM caseload_cache WHERE specialist_id = $1",
      [specialistId],
    );
    return result.rowCount ?? 0;
  });
}

// Resets the caseload-specific state between tests: the entire
// `caseload_cache` table and only the `caseload.hydrated` rows in
// `audit_log`. Scoping the audit DELETE (instead of a bare TRUNCATE) keeps
// any unrelated audit rows (e.g. `auth.session_start` from a prior OAuth
// round-trip in the same suite) intact — defensive against a future
// parallel-capable run, even though `workers: 1` makes the broader
// truncate safe today.
export async function truncateCaseloadTables(): Promise<void> {
  await withClient(async (client) => {
    await client.query("TRUNCATE TABLE caseload_cache RESTART IDENTITY");
    await client.query("DELETE FROM audit_log WHERE action_type = 'caseload.hydrated'");
  });
}

export interface CaseloadAuditRow {
  readonly timestamp: Date;
  readonly outcome: string;
  readonly queueId: string | null;
  readonly participantCount: number | null;
}

// Reads the `caseload.hydrated` audit row(s) written on the cold path. The
// payload metadata's `queue_id` and `participant_count` come straight from
// `get-caseload.ts:273` and let the spec assert the cold path actually ran
// (without a row, the perf assertion alone wouldn't distinguish a warm hit
// from a cold rehydrate).
export async function findCaseloadHydratedAuditRows(
  specialistId: string = SPECIALIST_ID,
): Promise<ReadonlyArray<CaseloadAuditRow>> {
  return withClient(async (client) => {
    const result = await client.query(
      `SELECT timestamp, outcome, payload_metadata
         FROM audit_log
        WHERE specialist_id = $1 AND action_type = 'caseload.hydrated'
        ORDER BY timestamp ASC`,
      [specialistId],
    );
    return result.rows.map((row) => {
      const metadata = row.payload_metadata as
        | { queue_id?: string; participant_count?: number }
        | null;
      return {
        timestamp: new Date(row.timestamp as string | Date),
        outcome: row.outcome as string,
        queueId: metadata?.queue_id ?? null,
        participantCount: metadata?.participant_count ?? null,
      };
    });
  });
}
