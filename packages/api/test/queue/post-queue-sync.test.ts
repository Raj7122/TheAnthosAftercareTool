// Unit tests for `handleQueueSync` (E-18 POST /api/v1/queue/sync, P3C-06).
// Every DB / SF / session seam is faked — no real PG, no real cookies, no
// real rate limiter. Coverage targets the ticket DoD + Q1 endpoint-shell
// scope:
//   - auth gate (401 from withSession)
//   - idempotency gate (400 IDEMPOTENCY_KEY_REQUIRED)
//   - role gate (specialist-only per §8.3.2 L1995)
//   - rate limit (1 per 2s per specialist, anti-thrash; §6 L371)
//   - 200 §7.5.2 body — preserves the published `itemsRouterToReview`
//     spelling
//   - audit row written PRE-response, no PII
//   - replay no-op via withIdempotency (duplicate Idempotency-Key)
//   - repository failure → 500 (no silent swallow)

import { hashToken, loadSessionConfig, mintToken } from "@anthos/auth";
import type { Role } from "@anthos/auth";
import type {
  DbOrTx,
  PendingQueueResult,
  StatusCounts,
} from "@anthos/persistence";
import { describe, expect, it, vi } from "vitest";

import { handleQueueSync } from "../../src/queue/post-queue-sync.js";
import type { QueueSyncHandlerOptions } from "../../src/queue/post-queue-sync.js";
import type { QueueSyncBody } from "../../src/queue/dto.js";
import type {
  IdempotencyRecord,
  IdempotencyStatus,
  IdempotencyStore,
} from "../../src/idempotency/store.js";
import type { RateLimiter } from "../../src/ratelimit/store.js";
import type { SessionRecord, SessionStore } from "../../src/session/store.js";

// ── fixtures ────────────────────────────────────────────────────────────────

const SESSION_CONFIG = loadSessionConfig({});
const HOUR = 60 * 60 * 1000;
const SPECIALIST_ID = "0058K00000XYZAbQAO";
const IDEM_KEY = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-05-27T15:30:00Z");
const FAKE_DB = {} as unknown as DbOrTx;

function makeStore(): { store: SessionStore; seed: (role?: Role) => string } {
  const rows = new Map<string, SessionRecord>();
  let n = 0;
  const store: SessionStore = {
    create: () => Promise.reject(new Error("create unused")),
    getByTokenHash: (h) => Promise.resolve(rows.get(h) ?? null),
    getSalesforceRefreshToken: () => Promise.resolve(null),
    touch: () => Promise.resolve(),
    applySessionRefresh: () => Promise.resolve(),
    revoke: () => Promise.resolve(),
    cleanupExpired: () => Promise.resolve(0),
  };
  function seed(role: Role = "SPECIALIST"): string {
    n += 1;
    const token = mintToken();
    rows.set(hashToken(token), {
      id: `session-${n}`,
      specialistId: SPECIALIST_ID,
      role,
      lastActivityAt: new Date(),
      expiresAt: new Date(Date.now() + 11 * HOUR),
      revoked: false,
      displayName: "Marie Alcis",
      email: "malcis@anthoshome.org",
      timezone: "America/New_York",
    });
    return token;
  }
  return { store, seed };
}

interface FakeIdemRow {
  key: string;
  specialistId: string;
  status: IdempotencyStatus;
  requestHash: string | null;
  responseStatusCode: number | null;
  responseBody: unknown;
  traceId: string | null;
  expiresAt: Date;
}

function makeIdemStore(): IdempotencyStore {
  const rows = new Map<string, FakeIdemRow>();
  return {
    acquire(input) {
      if (rows.has(input.key)) return Promise.resolve(null);
      const row: FakeIdemRow = {
        key: input.key,
        specialistId: input.specialistId,
        status: "IN_FLIGHT",
        requestHash: input.requestHash,
        responseStatusCode: null,
        responseBody: null,
        traceId: input.traceId,
        expiresAt: new Date(Date.now() + 24 * HOUR),
      };
      rows.set(input.key, row);
      return Promise.resolve({ ...row } as IdempotencyRecord);
    },
    get(key) {
      const row = rows.get(key);
      return Promise.resolve(row ? ({ ...row } as IdempotencyRecord) : null);
    },
    markCompleted(key, code, body) {
      const row = rows.get(key);
      if (row) {
        row.status = "COMPLETED";
        row.responseStatusCode = code;
        row.responseBody = body;
      }
      return Promise.resolve();
    },
    markFailedTerminal(key, code, body) {
      const row = rows.get(key);
      if (row) {
        row.status = "FAILED_TERMINAL";
        row.responseStatusCode = code;
        row.responseBody = body;
      }
      return Promise.resolve();
    },
    delete(key) {
      rows.delete(key);
      return Promise.resolve();
    },
    cleanupExpired() {
      return Promise.resolve(0);
    },
  };
}

function makeRateLimiter(allowed = true): {
  limiter: RateLimiter;
  checkAndConsume: ReturnType<typeof vi.fn>;
} {
  const checkAndConsume = vi.fn(() =>
    Promise.resolve(allowed ? { allowed: true } : { allowed: false, retryAfterSeconds: 2 }),
  );
  return {
    limiter: { checkAndConsume } as RateLimiter,
    checkAndConsume,
  };
}

function emptyCounts(): StatusCounts {
  return {
    pending_sync: 0,
    in_flight: 0,
    review_required_reassigned: 0,
    review_required_terminated: 0,
    failed_max_retries: 0,
  };
}

interface AuditCapture {
  audits: Array<{
    actionType: string;
    outcome: string;
    specialistId: string;
    traceId?: string;
    participantId?: string;
    salesforceRecordId?: string;
    channel?: string;
    payloadMetadata?: Record<string, unknown>;
  }>;
  writer: NonNullable<QueueSyncHandlerOptions["writeAudit"]>;
}

function makeAuditCapture(): AuditCapture {
  const audits: AuditCapture["audits"] = [];
  const writer: NonNullable<QueueSyncHandlerOptions["writeAudit"]> = vi.fn(
    (_db, entry) => {
      audits.push({
        actionType: entry.actionType,
        outcome: entry.outcome,
        specialistId: entry.specialistId,
        ...(entry.traceId !== undefined ? { traceId: entry.traceId } : {}),
        ...(entry.participantId !== undefined
          ? { participantId: entry.participantId }
          : {}),
        ...(entry.salesforceRecordId !== undefined
          ? { salesforceRecordId: entry.salesforceRecordId }
          : {}),
        ...(entry.channel !== undefined ? { channel: entry.channel } : {}),
        ...(entry.payloadMetadata !== undefined
          ? { payloadMetadata: entry.payloadMetadata as Record<string, unknown> }
          : {}),
      });
      return Promise.resolve({ id: `audit-${audits.length}` });
    },
  );
  return { audits, writer };
}

function syncReq(
  token: string | undefined,
  idempotencyKey: string | null = IDEM_KEY,
): Request {
  const headers = new Headers();
  if (token !== undefined) headers.set("Cookie", `anthos_session=${token}`);
  if (idempotencyKey !== null) headers.set("Idempotency-Key", idempotencyKey);
  return new Request("https://bff.test/api/v1/queue/sync", {
    method: "POST",
    headers,
  });
}

function baseOptions(
  store: SessionStore,
  result: PendingQueueResult,
  overrides: Partial<QueueSyncHandlerOptions> = {},
): QueueSyncHandlerOptions {
  const audit = overrides.writeAudit ?? makeAuditCapture().writer;
  return {
    store,
    sessionConfig: SESSION_CONFIG,
    idempotencyStore: makeIdemStore(),
    rateLimiter: makeRateLimiter(true).limiter,
    db: FAKE_DB,
    writeAudit: audit,
    getPendingImpl: vi.fn(() => Promise.resolve(result)),
    now: () => NOW,
    ...overrides,
  };
}

// ── auth + idempotency gates ────────────────────────────────────────────────

describe("handleQueueSync — auth + idempotency gates", () => {
  it("401 AUTH_SESSION_INVALID when no session cookie is present", async () => {
    const { store } = makeStore();
    const res = await handleQueueSync(
      syncReq(undefined),
      baseOptions(store, { rows: [], counts: emptyCounts(), queueDepth: 0 }),
    );
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe(
      "AUTH_SESSION_INVALID",
    );
  });

  it("400 IDEMPOTENCY_KEY_REQUIRED when header is missing", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const res = await handleQueueSync(
      syncReq(token, null),
      baseOptions(store, { rows: [], counts: emptyCounts(), queueDepth: 0 }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe(
      "IDEMPOTENCY_KEY_REQUIRED",
    );
  });

  it("400 IDEMPOTENCY_KEY_INVALID when header is not a UUIDv4", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const res = await handleQueueSync(
      syncReq(token, "not-a-uuid"),
      baseOptions(store, { rows: [], counts: emptyCounts(), queueDepth: 0 }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe(
      "IDEMPOTENCY_KEY_INVALID",
    );
  });
});

// ── role gate (API §8.3.2 L1995: specialist-only) ───────────────────────────

describe("handleQueueSync — role gate", () => {
  it.each(["SUPERVISOR", "VP", "SYSTEM_ADMIN"] as const)(
    "403 ROLE_INSUFFICIENT_SCOPE for role %s",
    async (role) => {
      const { store, seed } = makeStore();
      const token = seed(role);
      const { audits, writer } = makeAuditCapture();
      const { limiter, checkAndConsume } = makeRateLimiter(true);
      const getPending = vi.fn(() =>
        Promise.reject(new Error("repo should not run")),
      );
      const res = await handleQueueSync(
        syncReq(token),
        baseOptions(
          store,
          { rows: [], counts: emptyCounts(), queueDepth: 0 },
          {
            writeAudit: writer,
            rateLimiter: limiter,
            getPendingImpl: getPending,
          },
        ),
      );
      expect(res.status).toBe(403);
      const body = (await res.json()) as {
        code: string;
        details: { reason: string };
      };
      expect(body.code).toBe("ROLE_INSUFFICIENT_SCOPE");
      expect(body.details.reason).toBe("role_not_permitted");
      // Pre-mutation rejections (role gate) do NOT write audit rows nor
      // consume rate-limit budget — match the create-barrier in-file
      // precedent.
      expect(audits).toEqual([]);
      expect(checkAndConsume).not.toHaveBeenCalled();
      expect(getPending).not.toHaveBeenCalled();
    },
  );
});

// ── rate limit (1 per 2s per specialist; §6 L371) ───────────────────────────

describe("handleQueueSync — rate limit", () => {
  it("429 RATE_LIMITED when the limiter rejects (anti-thrash)", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { audits, writer } = makeAuditCapture();
    const { limiter, checkAndConsume } = makeRateLimiter(false);
    const getPending = vi.fn(() =>
      Promise.reject(new Error("repo should not run")),
    );

    const res = await handleQueueSync(
      syncReq(token),
      baseOptions(
        store,
        { rows: [], counts: emptyCounts(), queueDepth: 0 },
        {
          writeAudit: writer,
          rateLimiter: limiter,
          getPendingImpl: getPending,
        },
      ),
    );

    expect(res.status).toBe(429);
    const body = (await res.json()) as {
      code: string;
      details: { retryAfterSeconds: number; limit: number };
    };
    expect(body.code).toBe("RATE_LIMITED");
    expect(body.details.retryAfterSeconds).toBe(2);
    expect(body.details.limit).toBe(1);
    expect(res.headers.get("Retry-After")).toBe("2");

    expect(checkAndConsume).toHaveBeenCalledWith(
      `queue.sync:${SPECIALIST_ID}`,
      2,
    );
    // 429 is not audited at this endpoint (mirrors the in-flight
    // idempotency / origin-CSRF posture).
    expect(audits).toEqual([]);
    expect(getPending).not.toHaveBeenCalled();
  });
});

// ── happy path ──────────────────────────────────────────────────────────────

describe("handleQueueSync — specialist success path", () => {
  it("200 with the §7.5.2 body shape; preserves `itemsRouterToReview` spelling", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const result: PendingQueueResult = {
      rows: [],
      counts: { ...emptyCounts(), pending_sync: 3 },
      queueDepth: 3,
    };
    const { audits, writer } = makeAuditCapture();
    const getPending = vi.fn(() => Promise.resolve(result));

    const res = await handleQueueSync(
      syncReq(token),
      baseOptions(store, result, {
        writeAudit: writer,
        getPendingImpl: getPending,
      }),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/application\/json/);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Trace-Id")).not.toBeNull();
    expect(getPending).toHaveBeenCalledWith(FAKE_DB, SPECIALIST_ID);

    const body = (await res.json()) as QueueSyncBody;
    expect(body.syncTriggeredAt).toBe(NOW.toISOString());
    expect(body.itemsAttempted).toBe(3);
    expect(body.itemsCompleted).toBe(0);
    expect(body.itemsRouterToReview).toBe(0);
    expect(body.itemsRemaining).toBe(3);

    // Audit row written PRE-response, no PII.
    expect(audits).toHaveLength(1);
    const audit = audits[0];
    // `queue.force_sync_triggered` is authoritative per API §6 row 371 but
    // is NOT in the §11.6 action_type catalog (line 2442) — flagged as a
    // forward spec amendment. See the inline note in post-queue-sync.ts.
    expect(audit?.actionType).toBe("queue.force_sync_triggered");
    expect(audit?.outcome).toBe("SUCCESS");
    expect(audit?.specialistId).toBe(SPECIALIST_ID);
    expect(audit?.channel).toBe("system");
    expect(audit?.participantId).toBeUndefined();
    expect(audit?.salesforceRecordId).toBeUndefined();
    expect(audit?.payloadMetadata).toEqual({
      items_attempted: 3,
      items_completed: 0,
      items_router_to_review: 0,
      items_remaining: 3,
      source: "tool",
    });
  });

  it("200 with zero counts when the specialist has nothing pending", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { audits, writer } = makeAuditCapture();

    const res = await handleQueueSync(
      syncReq(token),
      baseOptions(
        store,
        { rows: [], counts: emptyCounts(), queueDepth: 0 },
        { writeAudit: writer },
      ),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as QueueSyncBody;
    expect(body.itemsAttempted).toBe(0);
    expect(body.itemsRemaining).toBe(0);
    expect(audits).toHaveLength(1);
  });
});

// ── idempotency replay (Pattern D) ──────────────────────────────────────────

describe("handleQueueSync — idempotency replay", () => {
  it("replays the cached body on duplicate Idempotency-Key; handler not re-run", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const result: PendingQueueResult = {
      rows: [],
      counts: { ...emptyCounts(), pending_sync: 2 },
      queueDepth: 2,
    };
    const { audits, writer } = makeAuditCapture();
    const getPending = vi.fn(() => Promise.resolve(result));
    // Share one idempotency store + one rate limiter across both calls so the
    // second call's lock acquisition hits the cached row.
    const sharedIdem = makeIdemStore();
    const { limiter, checkAndConsume } = makeRateLimiter(true);

    const first = await handleQueueSync(
      syncReq(token),
      baseOptions(store, result, {
        writeAudit: writer,
        getPendingImpl: getPending,
        idempotencyStore: sharedIdem,
        rateLimiter: limiter,
      }),
    );
    expect(first.status).toBe(200);
    expect(audits).toHaveLength(1);
    expect(checkAndConsume).toHaveBeenCalledTimes(1);

    const firstBody = await first.clone().json();

    const second = await handleQueueSync(
      syncReq(token),
      baseOptions(store, result, {
        writeAudit: writer,
        getPendingImpl: getPending,
        idempotencyStore: sharedIdem,
        rateLimiter: limiter,
      }),
    );
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(firstBody);

    // The replay must NOT invoke the handler: no new audit row, no new
    // repository read, no new rate-limit consume.
    expect(audits).toHaveLength(1);
    expect(getPending).toHaveBeenCalledTimes(1);
    expect(checkAndConsume).toHaveBeenCalledTimes(1);
  });
});

// ── repository failure ─────────────────────────────────────────────────────

describe("handleQueueSync — repository failure", () => {
  it("500 INTERNAL_ERROR when the repository throws (no silent swallow)", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { audits, writer } = makeAuditCapture();
    const getPending = vi.fn(() => Promise.reject(new Error("pg down")));

    const res = await handleQueueSync(
      syncReq(token),
      baseOptions(
        store,
        { rows: [], counts: emptyCounts(), queueDepth: 0 },
        { writeAudit: writer, getPendingImpl: getPending },
      ),
    );

    expect(res.status).toBe(500);
    expect(((await res.json()) as { code: string }).code).toBe(
      "INTERNAL_ERROR",
    );
    // The 500 short-circuits before the audit write — same posture as
    // get-queue-pending repository-failure. No `queue.force_sync_triggered`
    // row exists for a flush that never started.
    expect(audits).toEqual([]);
  });
});
