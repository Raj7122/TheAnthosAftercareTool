import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { withIdempotency } from "../src/idempotency/middleware.js";

// End-to-end proof of the P1A-06 load-bearing invariant: one inbound request
// produces an idempotency_keys row and an audit_log row sharing a single
// trace_id (ERD §8.2 cross-table correlation contract). Hits a real Postgres
// via DEMO_POSTGRES_URL; skipped when unset so CI stays green. Every run uses
// fresh UUIDs, so it needs no table truncation.
//
// withIdempotency is import-safe (its Postgres store is reached only via a
// dynamic import); @anthos/persistence is lazy-imported in beforeAll so its
// client — which throws on a missing DEMO_POSTGRES_URL — never evaluates when
// the suite is skipped.

const RUN = !!process.env.DEMO_POSTGRES_URL;

describe.skipIf(!RUN)("trace_id end-to-end correlation (integration)", () => {
  let db: (typeof import("@anthos/persistence"))["db"];
  let pool: (typeof import("@anthos/persistence"))["pool"];
  let closeDb: (typeof import("@anthos/persistence"))["closeDb"];
  let writeAuditEntry: (typeof import("@anthos/audit"))["writeAuditEntry"];

  beforeAll(async () => {
    const persistence = await import("@anthos/persistence");
    db = persistence.db;
    pool = persistence.pool;
    closeDb = persistence.closeDb;
    ({ writeAuditEntry } = await import("@anthos/audit"));
  });

  afterAll(async () => {
    await closeDb();
  });

  it("a single request writes idempotency_keys + audit_log rows sharing one trace_id", async () => {
    const traceId = randomUUID();
    const idempotencyKey = randomUUID();
    const specialistId = "S-INT-TRACE";

    // A mutating handler that writes an audit row with the inbound trace_id —
    // the same id the idempotency middleware persists on the lock row. No store
    // is injected: the middleware resolves the real Demo-Mode Postgres store.
    const handler = withIdempotency(async (_req, ctx) => {
      await writeAuditEntry(db, {
        specialistId: ctx.specialistId,
        // Synthetic test-only action type — not from the API §11.6 catalog.
        actionType: "trace.correlation.test",
        outcome: "SUCCESS",
        traceId: ctx.traceId,
      });
      return new Response(JSON.stringify({ ok: true }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    });

    const res = await handler(
      new Request("https://bff.test/api/calls", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
          "X-Trace-Id": traceId,
        },
        body: JSON.stringify({ x: 1 }),
      }),
      { specialistId },
    );

    expect(res.status).toBe(201);
    expect(res.headers.get("X-Trace-Id")).toBe(traceId);

    const idem = await pool.query(
      "SELECT trace_id FROM idempotency_keys WHERE key = $1",
      [idempotencyKey],
    );
    const audit = await pool.query(
      "SELECT trace_id FROM audit_log WHERE trace_id = $1",
      [traceId],
    );

    // Both persistence touchpoints carry the one trace_id — the request is
    // joinable end-to-end (ERD §8.2).
    expect(idem.rows).toHaveLength(1);
    expect(idem.rows[0]?.trace_id).toBe(traceId);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]?.trace_id).toBe(traceId);
  });
});
