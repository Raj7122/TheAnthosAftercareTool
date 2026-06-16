// Unit tests for `handleQueuePending` (E-17 GET /api/v1/queue/pending,
// P3C-05). Every DB / session seam is faked — no real PG, no real cookies.
//
// Coverage: auth gate (401), role gate (specialist-only per §8.3.2 L1994),
// happy-path body shape, redaction of `payloadPreview`, bounded
// `maxQueueDepth`, and the X-Trace-Id + Cache-Control invariants.

import { hashToken, loadSessionConfig, mintToken } from "@anthos/auth";
import type { Role } from "@anthos/auth";
import type {
  DbOrTx,
  OfflineQueueRow,
  PendingQueueResult,
  StatusCounts,
} from "@anthos/persistence";
import { describe, expect, it, vi } from "vitest";

import { handleQueuePending } from "../../src/queue/get-queue-pending.js";
import type { QueuePendingHandlerOptions } from "../../src/queue/get-queue-pending.js";
import type { QueuePendingBody } from "../../src/queue/dto.js";
import type { SessionRecord, SessionStore } from "../../src/session/store.js";

// ── fixtures ────────────────────────────────────────────────────────────────

const SESSION_CONFIG = loadSessionConfig({});
const HOUR = 60 * 60 * 1000;
const SPECIALIST_ID = "0058K00000XYZAbQAO";
// A non-DB sentinel — every DB-touching seam is faked, so `db` is never read.
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

function queuePendingReq(token?: string): Request {
  const headers = new Headers();
  if (token !== undefined) headers.set("Cookie", `anthos_session=${token}`);
  const url = new URL("https://bff.test/api/v1/queue/pending");
  return new Request(url, { method: "GET", headers });
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

function makeRow(overrides: Partial<OfflineQueueRow> = {}): OfflineQueueRow {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    specialistId: SPECIALIST_ID,
    participantId: "a015g00000ABCDxQAO",
    actionType: "call.logged",
    status: "review_required_reassigned",
    createdAt: new Date("2026-05-09T10:23:00Z"),
    lastAttemptAt: new Date("2026-05-09T14:35:00Z"),
    retryCount: 2,
    errorDetails: {
      sfErrorCode: "INVALID_CROSS_REFERENCE_KEY",
      message: "Participant reassigned",
    },
    payload: { status: "Completed", summary: "Brief check-in call" },
    ...overrides,
  };
}

function baseOptions(
  store: SessionStore,
  result: PendingQueueResult,
  overrides: Partial<QueuePendingHandlerOptions> = {},
): QueuePendingHandlerOptions {
  return {
    store,
    sessionConfig: SESSION_CONFIG,
    db: FAKE_DB,
    getPendingImpl: vi.fn(() => Promise.resolve(result)),
    ...overrides,
  };
}

// ── auth gate ───────────────────────────────────────────────────────────────

describe("handleQueuePending — auth gate", () => {
  it("401 AUTH_SESSION_INVALID when no session cookie is present", async () => {
    const { store } = makeStore();
    const res = await handleQueuePending(
      queuePendingReq(),
      baseOptions(store, { rows: [], counts: emptyCounts(), queueDepth: 0 }),
    );
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe(
      "AUTH_SESSION_INVALID",
    );
  });
});

// ── role gate (API §8.3.2 L1994: specialist-only) ───────────────────────────

describe("handleQueuePending — role gate", () => {
  it.each(["SUPERVISOR", "VP", "SYSTEM_ADMIN"] as const)(
    "403 ROLE_INSUFFICIENT_SCOPE for role %s",
    async (role) => {
      const { store, seed } = makeStore();
      const token = seed(role);
      const getPending = vi.fn(() => Promise.reject(new Error("should not run")));
      const res = await handleQueuePending(
        queuePendingReq(token),
        baseOptions(
          store,
          { rows: [], counts: emptyCounts(), queueDepth: 0 },
          { getPendingImpl: getPending },
        ),
      );
      expect(res.status).toBe(403);
      const body = (await res.json()) as {
        code: string;
        details: { reason: string };
      };
      expect(body.code).toBe("ROLE_INSUFFICIENT_SCOPE");
      expect(body.details.reason).toBe("role_not_permitted");
      expect(getPending).not.toHaveBeenCalled();
    },
  );
});

// ── happy path ──────────────────────────────────────────────────────────────

describe("handleQueuePending — specialist success path", () => {
  it("returns 200 with the §7.5.1 body shape for a specialist with pending items", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const result: PendingQueueResult = {
      rows: [makeRow()],
      counts: { ...emptyCounts(), review_required_reassigned: 1 },
      queueDepth: 1,
    };
    const getPending = vi.fn(() => Promise.resolve(result));

    const res = await handleQueuePending(
      queuePendingReq(token),
      baseOptions(store, result, { getPendingImpl: getPending }),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/application\/json/);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Trace-Id")).not.toBeNull();

    // The repository was called with the session-resolved specialistId — never
    // a query param.
    expect(getPending).toHaveBeenCalledWith(FAKE_DB, SPECIALIST_ID);

    const body = (await res.json()) as QueuePendingBody;
    expect(body.specialistId).toBe(SPECIALIST_ID);
    expect(body.queueDepth).toBe(1);
    expect(body.maxQueueDepth).toBe(100);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.queueItemId).toBe(
      "00000000-0000-0000-0000-000000000001",
    );
    expect(body.items[0]?.suggestedResolution).toBe("ESCALATE_TO_SUPERVISOR");
    expect(body.items[0]?.resolutionOptions).toEqual([
      "DISCARD",
      "REASSIGN_RETRY",
      "ESCALATE_TO_SUPERVISOR",
    ]);
  });

  it("returns 200 with an empty envelope when the specialist has no pending items", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const result: PendingQueueResult = {
      rows: [],
      counts: emptyCounts(),
      queueDepth: 0,
    };

    const res = await handleQueuePending(
      queuePendingReq(token),
      baseOptions(store, result),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as QueuePendingBody;
    expect(body.items).toEqual([]);
    expect(body.queueDepth).toBe(0);
    expect(body.counts).toEqual(emptyCounts());
  });

  it("redacts payloadPreview — drops non-allow-listed fields, never echoes PHI", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const result: PendingQueueResult = {
      rows: [
        makeRow({
          payload: {
            status: "Completed",
            // PHI-suspect fields the redactor MUST drop.
            participantName: "Marie Alcis",
            phoneNumber: "+15551234567",
            email: "marie@example.org",
            notes: "free-text PHI",
            summary: "Brief check-in call",
          },
        }),
      ],
      counts: { ...emptyCounts(), review_required_reassigned: 1 },
      queueDepth: 1,
    };

    const res = await handleQueuePending(
      queuePendingReq(token),
      baseOptions(store, result),
    );

    const body = (await res.json()) as QueuePendingBody;
    const preview = body.items[0]?.payloadPreview;
    expect(preview).toEqual({
      status: "Completed",
      snippet: "Brief check-in call",
    });
    expect(preview).not.toHaveProperty("participantName");
    expect(preview).not.toHaveProperty("phoneNumber");
    expect(preview).not.toHaveProperty("email");
    expect(preview).not.toHaveProperty("notes");
  });
});

// ── repository failure ─────────────────────────────────────────────────────

describe("handleQueuePending — repository failure", () => {
  it("500 INTERNAL_ERROR when the repository throws (no silent swallow)", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const getPending = vi.fn(() => Promise.reject(new Error("pg down")));

    const res = await handleQueuePending(
      queuePendingReq(token),
      baseOptions(
        store,
        { rows: [], counts: emptyCounts(), queueDepth: 0 },
        { getPendingImpl: getPending },
      ),
    );

    expect(res.status).toBe(500);
    expect(((await res.json()) as { code: string }).code).toBe("INTERNAL_ERROR");
  });
});
