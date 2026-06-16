import { createLogger } from "@anthos/logging";
import type { DbOrTx } from "@anthos/persistence";
import { describe, expect, it } from "vitest";

import type { OriginConfig } from "../../src/origin/config.js";
import { enforceOrigin } from "../../src/origin/guard.js";

const CONFIG: OriginConfig = { allowedOrigins: ["https://app.example"] };
const TRACE_ID = "trace-csrf-test";
const logger = createLogger({ module: "test.origin" });

// Minimal stand-in for the Drizzle insert chain `writeAuditEntry` drives — the
// real writer (incl. its no-PII assertion) runs against it. Mirrors the fake
// in packages/api/test/auth/logout.test.ts.
function makeFakeDb(): { db: DbOrTx; inserted: Record<string, unknown>[] } {
  const inserted: Record<string, unknown>[] = [];
  const db = {
    insert() {
      return {
        values(value: Record<string, unknown>) {
          inserted.push(value);
          return {
            returning: () => Promise.resolve([{ id: `audit-${inserted.length}` }]),
          };
        },
      };
    },
  };
  return { db: db as unknown as DbOrTx, inserted };
}

function mutationRequest(headers: Record<string, string> = {}): Request {
  return new Request("https://app.example/api/v1/auth/logout", {
    method: "POST",
    headers,
  });
}

describe("enforceOrigin", () => {
  it("returns null (proceed) when the Origin is in the allowlist", async () => {
    const { db, inserted } = makeFakeDb();
    const res = await enforceOrigin(mutationRequest({ Origin: "https://app.example" }), {
      config: CONFIG,
      getDb: () => Promise.resolve(db),
      traceId: TRACE_ID,
      logger,
    });
    expect(res).toBeNull();
    expect(inserted).toHaveLength(0); // happy path writes no audit row
  });

  it("returns null for a safe method without consulting the allowlist", async () => {
    const { db } = makeFakeDb();
    const req = new Request("https://app.example/x", {
      method: "GET",
      headers: { Origin: "https://evil.example" },
    });
    const res = await enforceOrigin(req, {
      config: CONFIG,
      getDb: () => Promise.resolve(db),
      traceId: TRACE_ID,
      logger,
    });
    expect(res).toBeNull();
  });

  it("rejects a mismatched Origin with the 403 CSRF_ORIGIN_MISMATCH envelope", async () => {
    const { db } = makeFakeDb();
    const res = await enforceOrigin(mutationRequest({ Origin: "https://evil.example" }), {
      config: CONFIG,
      getDb: () => Promise.resolve(db),
      traceId: TRACE_ID,
      logger,
    });
    expect(res).not.toBeNull();
    expect(res?.status).toBe(403);
    expect(await res?.json()).toEqual({
      code: "CSRF_ORIGIN_MISMATCH",
      message: "Request origin not permitted.",
      traceId: TRACE_ID,
    });
    expect(res?.headers.get("Cache-Control")).toBe("no-store");
    expect(res?.headers.get("X-Trace-Id")).toBe(TRACE_ID);
  });

  it("rejects an absent Origin on a mutation", async () => {
    const { db } = makeFakeDb();
    const res = await enforceOrigin(mutationRequest(), {
      config: CONFIG,
      getDb: () => Promise.resolve(db),
      traceId: TRACE_ID,
      logger,
    });
    expect(res?.status).toBe(403);
  });

  it("writes one auth.failure audit row (reason csrf_origin_mismatch) — sentinel actor, FAILED, no PII", async () => {
    const { db, inserted } = makeFakeDb();
    await enforceOrigin(mutationRequest({ Origin: "https://evil.example" }), {
      config: CONFIG,
      getDb: () => Promise.resolve(db),
      traceId: TRACE_ID,
      logger,
    });
    expect(inserted).toHaveLength(1);
    // API §11.6 catalogs `auth.failure`; the CSRF mode rides in reason.
    expect(inserted[0]).toMatchObject({
      specialistId: "anonymous",
      actionType: "auth.failure",
      outcome: "FAILED",
      traceId: TRACE_ID,
      payloadMetadata: {
        reason: "csrf_origin_mismatch",
        origin: "https://evil.example",
        method: "POST",
      },
    });
  });

  it("records an absent Origin as \"absent\" in the audit payload", async () => {
    const { db, inserted } = makeFakeDb();
    await enforceOrigin(mutationRequest(), {
      config: CONFIG,
      getDb: () => Promise.resolve(db),
      traceId: TRACE_ID,
      logger,
    });
    expect((inserted[0]?.payloadMetadata as Record<string, unknown>).origin).toBe("absent");
  });

  it("does not resolve the DB handle on the happy path", async () => {
    let getDbCalls = 0;
    const res = await enforceOrigin(mutationRequest({ Origin: "https://app.example" }), {
      config: CONFIG,
      getDb: () => {
        getDbCalls += 1;
        return Promise.resolve(makeFakeDb().db);
      },
      traceId: TRACE_ID,
      logger,
    });
    expect(res).toBeNull();
    expect(getDbCalls).toBe(0);
  });
});
