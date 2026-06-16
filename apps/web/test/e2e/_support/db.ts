// Test-DB helper for the P1B-07 E2E. The BFF under test writes the
// `auth.session_start` audit row to Postgres during the OAuth callback; the
// spec connects to the SAME database (`DEMO_POSTGRES_URL`) to assert the
// audit-before-response invariant (Immutable #5).
//
// A short-lived `pg.Client` per call — the helper makes only a handful of
// queries, so connection pooling would be over-engineering.

import pg from "pg";

import { POSTGRES_URL } from "./constants.js";

function newClient(): pg.Client {
  return new pg.Client({
    connectionString: POSTGRES_URL,
    // Mirror packages/persistence/src/db/client.ts: a `sslmode=disable` URL
    // (CI service container / local dev Postgres) terminates no TLS.
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

// Clear the auth-mutation tables so a re-run (locally; CI gets a fresh service
// container) starts from a known-empty ledger — the audit assertion expects
// EXACTLY one `auth.session_start` row.
export async function truncateAuthTables(): Promise<void> {
  await withClient((client) =>
    client.query("TRUNCATE TABLE audit_log, sessions RESTART IDENTITY"),
  );
}

export interface AuditRow {
  readonly timestamp: Date;
  readonly actionType: string;
  readonly specialistId: string;
  readonly outcome: string;
}

// All `auth.session_start` rows for a specialist, oldest first. The audit
// row's `timestamp` is DB-generated at INSERT (audit_log schema `defaultNow()`)
// — the callback awaits this write before it builds the 302, so the row is
// durable before the browser ever observes the response.
export async function findSessionStartAuditRows(
  specialistId: string,
): Promise<AuditRow[]> {
  return withClient(async (client) => {
    const result = await client.query(
      `SELECT timestamp, action_type, specialist_id, outcome
         FROM audit_log
        WHERE specialist_id = $1 AND action_type = 'auth.session_start'
        ORDER BY timestamp ASC`,
      [specialistId],
    );
    return result.rows.map((row) => ({
      timestamp: new Date(row.timestamp as string | Date),
      actionType: row.action_type as string,
      specialistId: row.specialist_id as string,
      outcome: row.outcome as string,
    }));
  });
}
