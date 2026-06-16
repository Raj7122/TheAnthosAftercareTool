// Unit tests for `handleQueueResolve` (E-19 POST /api/v1/queue/:id/resolve,
// P3C-07). Every DB / session / idempotency seam is faked — no real PG, no
// real cookies. Coverage targets the ticket DoD:
//   - auth gate (401 from withSession)
//   - idempotency gate (400 IDEMPOTENCY_KEY_REQUIRED / _INVALID)
//   - role gate (specialist-only per API §8.3.2 row 1996)
//   - validation gates (400 VALIDATION_FAILED for body shape errors)
//   - ownership / not-found (404 — missing id AND cross-specialist BOTH
//     collapse into the same response per PII firewall posture)
//   - state gate (409 QUEUE_ITEM_NOT_RESOLVABLE for non-Review-Required rows)
//   - three happy paths: 200 DISCARD, 200 REASSIGN_RETRY, 201 ESCALATE
//   - audit pair written PRE-response, no PII
//   - idempotency replay returns cached body; handler invoked once
//   - repository read failure → 500; repository write failure → 500
//
// SPEC NUMBERING — the ticket + impl-plan §3 row 463 both label this E-20,
// but API_v1_3.md §7.5 row 372 + §7.5.3 carry it as E-19. Tests follow the
// API doc per spec precedence.

import { hashToken, loadSessionConfig, mintToken } from "@anthos/auth";
import type { Role } from "@anthos/auth";
import type {
  ApplyQueueResolutionInput,
  DbOrTx,
  OfflineQueueRow,
  OfflineQueueStatus,
} from "@anthos/persistence";
import { describe, expect, it, vi } from "vitest";

import { handleQueueResolve } from "../../src/queue/post-queue-resolve.js";
import type { QueueResolveHandlerOptions } from "../../src/queue/post-queue-resolve.js";
import type {
  QueueResolveEscalationBody,
  QueueResolveSuccessBody,
} from "../../src/queue/dto.js";
import type {
  IdempotencyRecord,
  IdempotencyStatus,
  IdempotencyStore,
} from "../../src/idempotency/store.js";
import type { SessionRecord, SessionStore } from "../../src/session/store.js";

// ── fixtures ────────────────────────────────────────────────────────────────

const SESSION_CONFIG = loadSessionConfig({});
const HOUR = 60 * 60 * 1000;
const SPECIALIST_ID = "0058K00000XYZAbQAO";
const OTHER_SPECIALIST_ID = "0058K00000OTHERaQAO";
const NEW_OWNER_ID = "0058K00000NEWxxQAO";
const IDEM_KEY = "11111111-1111-4111-8111-111111111111";
const IDEM_KEY_2 = "22222222-2222-4222-8222-222222222222";
const ITEM_ID = "c1b3a8d0-7e1f-4f0a-bf09-1f9c3a3b2e7c";
const ESCALATION_ID = "e1f2a3d0-7e1f-4f0a-bf09-1f9c3a3b2e7c";
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

function makeQueueItem(
  overrides: Partial<OfflineQueueRow> = {},
): OfflineQueueRow {
  return {
    id: ITEM_ID,
    specialistId: SPECIALIST_ID,
    participantId: "003abcDEFGHIJK0001",
    actionType: "participants.call.logged",
    status: "review_required_reassigned",
    createdAt: new Date("2026-05-09T11:00:00Z"),
    lastAttemptAt: new Date("2026-05-09T11:00:05Z"),
    retryCount: 2,
    errorDetails: {
      sfErrorCode: "INVALID_CROSS_REFERENCE_KEY",
      message: "Caseload reassignment",
    },
    payload: { summary: "called participant", outcome: "voicemail" },
    ...overrides,
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
  writer: NonNullable<QueueResolveHandlerOptions["writeAudit"]>;
}

function makeAuditCapture(): AuditCapture {
  const audits: AuditCapture["audits"] = [];
  const writer: NonNullable<QueueResolveHandlerOptions["writeAudit"]> = vi.fn(
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

function resolveReq(
  token: string | undefined,
  body: Record<string, unknown> | string | null,
  idempotencyKey: string | null = IDEM_KEY,
  itemId: string = ITEM_ID,
): Request {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (token !== undefined) headers.set("Cookie", `anthos_session=${token}`);
  if (idempotencyKey !== null) headers.set("Idempotency-Key", idempotencyKey);
  const bodyText =
    body === null ? undefined : typeof body === "string" ? body : JSON.stringify(body);
  return new Request(`https://bff.test/api/v1/queue/${itemId}/resolve`, {
    method: "POST",
    headers,
    body: bodyText,
  });
}

function routeCtx(id: string = ITEM_ID): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

function baseOptions(
  store: SessionStore,
  item: OfflineQueueRow | null,
  overrides: Partial<QueueResolveHandlerOptions> = {},
): QueueResolveHandlerOptions {
  const audit = overrides.writeAudit ?? makeAuditCapture().writer;
  return {
    store,
    sessionConfig: SESSION_CONFIG,
    idempotencyStore: makeIdemStore(),
    db: FAKE_DB,
    writeAudit: audit,
    findQueueItemByIdImpl: vi.fn(() => Promise.resolve(item)),
    applyQueueResolutionImpl: vi.fn((_db, _input: ApplyQueueResolutionInput) =>
      Promise.resolve(1),
    ),
    now: () => NOW,
    newEscalationId: () => ESCALATION_ID,
    ...overrides,
  };
}

// ── auth + idempotency gates ────────────────────────────────────────────────

describe("handleQueueResolve — auth + idempotency gates", () => {
  it("401 AUTH_SESSION_INVALID when no session cookie is present", async () => {
    const { store } = makeStore();
    const res = await handleQueueResolve(
      resolveReq(undefined, { action: "DISCARD" }),
      routeCtx(),
      baseOptions(store, makeQueueItem()),
    );
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe(
      "AUTH_SESSION_INVALID",
    );
  });

  it("400 IDEMPOTENCY_KEY_REQUIRED when header is missing", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const res = await handleQueueResolve(
      resolveReq(token, { action: "DISCARD" }, null),
      routeCtx(),
      baseOptions(store, makeQueueItem()),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe(
      "IDEMPOTENCY_KEY_REQUIRED",
    );
  });

  it("400 IDEMPOTENCY_KEY_INVALID when header is not a UUIDv4", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const res = await handleQueueResolve(
      resolveReq(token, { action: "DISCARD" }, "not-a-uuid"),
      routeCtx(),
      baseOptions(store, makeQueueItem()),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe(
      "IDEMPOTENCY_KEY_INVALID",
    );
  });
});

// ── role gate ───────────────────────────────────────────────────────────────

describe("handleQueueResolve — role gate", () => {
  it.each(["SUPERVISOR", "VP", "SYSTEM_ADMIN"] as const)(
    "403 ROLE_INSUFFICIENT_SCOPE for role %s",
    async (role) => {
      const { store, seed } = makeStore();
      const token = seed(role);
      const { audits, writer } = makeAuditCapture();
      const find = vi.fn(() =>
        Promise.reject(new Error("find should not run for non-specialist")),
      );
      const apply = vi.fn(() =>
        Promise.reject(new Error("apply should not run for non-specialist")),
      );

      const res = await handleQueueResolve(
        resolveReq(token, { action: "DISCARD" }),
        routeCtx(),
        baseOptions(store, makeQueueItem(), {
          writeAudit: writer,
          findQueueItemByIdImpl: find,
          applyQueueResolutionImpl: apply,
        }),
      );

      expect(res.status).toBe(403);
      const body = (await res.json()) as {
        code: string;
        details: { reason: string };
      };
      expect(body.code).toBe("ROLE_INSUFFICIENT_SCOPE");
      expect(body.details.reason).toBe("role_not_permitted");
      expect(audits).toEqual([]);
      expect(find).not.toHaveBeenCalled();
      expect(apply).not.toHaveBeenCalled();
    },
  );
});

// ── validation gates ────────────────────────────────────────────────────────

describe("handleQueueResolve — validation gates", () => {
  it("400 VALIDATION_FAILED on malformed JSON body", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const res = await handleQueueResolve(
      resolveReq(token, "{not json"),
      routeCtx(),
      baseOptions(store, makeQueueItem()),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      code: string;
      details: { field: string; reason: string };
    };
    expect(body.code).toBe("VALIDATION_FAILED");
    expect(body.details.field).toBe("body");
    expect(body.details.reason).toBe("invalid_json");
  });

  it("400 VALIDATION_FAILED when action is missing", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const res = await handleQueueResolve(
      resolveReq(token, {}),
      routeCtx(),
      baseOptions(store, makeQueueItem()),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      code: string;
      details: { field: string };
    };
    expect(body.code).toBe("VALIDATION_FAILED");
    expect(body.details.field).toBe("action");
  });

  it("400 VALIDATION_FAILED when action is an unknown value", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const res = await handleQueueResolve(
      resolveReq(token, { action: "RETRY_LATER" }),
      routeCtx(),
      baseOptions(store, makeQueueItem()),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      code: string;
      details: { field: string };
    };
    expect(body.code).toBe("VALIDATION_FAILED");
    expect(body.details.field).toBe("action");
  });

  it("400 VALIDATION_FAILED when REASSIGN_RETRY omits newOwnerId", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const res = await handleQueueResolve(
      resolveReq(token, { action: "REASSIGN_RETRY" }),
      routeCtx(),
      baseOptions(store, makeQueueItem()),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      code: string;
      details: { field: string };
    };
    expect(body.code).toBe("VALIDATION_FAILED");
    expect(body.details.field).toBe("newOwnerId");
  });

  it("400 VALIDATION_FAILED when newOwnerId is not a Salesforce id", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const apply = vi.fn(() =>
      Promise.reject(new Error("apply should not run on invalid id")),
    );
    const res = await handleQueueResolve(
      resolveReq(token, {
        action: "REASSIGN_RETRY",
        newOwnerId: "not-a-salesforce-id",
      }),
      routeCtx(),
      baseOptions(store, makeQueueItem(), {
        applyQueueResolutionImpl: apply,
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      code: string;
      details: { field: string; reason: string };
    };
    expect(body.code).toBe("VALIDATION_FAILED");
    expect(body.details.field).toBe("newOwnerId");
    expect(body.details.reason).toBe("invalid_salesforce_id");
    expect(apply).not.toHaveBeenCalled();
  });

  it("400 VALIDATION_FAILED when notes exceeds 1000 chars", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const res = await handleQueueResolve(
      resolveReq(token, { action: "DISCARD", notes: "x".repeat(1001) }),
      routeCtx(),
      baseOptions(store, makeQueueItem()),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      code: string;
      details: { field: string };
    };
    expect(body.code).toBe("VALIDATION_FAILED");
    expect(body.details.field).toBe("notes");
  });

  it("400 VALIDATION_FAILED on unknown body keys (strict shape)", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const res = await handleQueueResolve(
      resolveReq(token, { action: "DISCARD", extra: "nope" }),
      routeCtx(),
      baseOptions(store, makeQueueItem()),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe(
      "VALIDATION_FAILED",
    );
  });
});

// ── ownership + state gates ─────────────────────────────────────────────────

describe("handleQueueResolve — ownership + state gates", () => {
  it("404 QUEUE_ITEM_NOT_FOUND when the id does not exist", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const apply = vi.fn(() =>
      Promise.reject(new Error("apply should not run for unknown id")),
    );
    const res = await handleQueueResolve(
      resolveReq(token, { action: "DISCARD" }),
      routeCtx(),
      baseOptions(store, null, { applyQueueResolutionImpl: apply }),
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe(
      "QUEUE_ITEM_NOT_FOUND",
    );
    expect(apply).not.toHaveBeenCalled();
  });

  it("404 QUEUE_ITEM_NOT_FOUND when the item belongs to another specialist", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const apply = vi.fn(() =>
      Promise.reject(new Error("apply should not run for cross-specialist")),
    );
    const res = await handleQueueResolve(
      resolveReq(token, { action: "DISCARD" }),
      routeCtx(),
      baseOptions(
        store,
        makeQueueItem({ specialistId: OTHER_SPECIALIST_ID }),
        { applyQueueResolutionImpl: apply },
      ),
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe(
      "QUEUE_ITEM_NOT_FOUND",
    );
    expect(apply).not.toHaveBeenCalled();
  });

  it.each([
    "pending_sync",
    "in_flight",
    "completed",
    "failed_max_retries",
    "discarded",
  ] as const satisfies ReadonlyArray<OfflineQueueStatus>)(
    "409 QUEUE_ITEM_NOT_RESOLVABLE when status is %s",
    async (status) => {
      const { store, seed } = makeStore();
      const token = seed("SPECIALIST");
      const apply = vi.fn(() =>
        Promise.reject(new Error("apply should not run on non-resolvable state")),
      );
      const res = await handleQueueResolve(
        resolveReq(token, { action: "DISCARD" }),
        routeCtx(),
        baseOptions(store, makeQueueItem({ status }), {
          applyQueueResolutionImpl: apply,
        }),
      );
      expect(res.status).toBe(409);
      const body = (await res.json()) as {
        code: string;
        details: { currentStatus: string };
      };
      expect(body.code).toBe("QUEUE_ITEM_NOT_RESOLVABLE");
      expect(body.details.currentStatus).toBe(status);
      expect(apply).not.toHaveBeenCalled();
    },
  );
});

// ── happy paths ─────────────────────────────────────────────────────────────

describe("handleQueueResolve — DISCARD happy path", () => {
  it("200, updates row to discarded, writes audit pair PRE-response", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { audits, writer } = makeAuditCapture();
    const apply = vi.fn(() => Promise.resolve(1));
    const item = makeQueueItem({ status: "review_required_reassigned" });

    const res = await handleQueueResolve(
      resolveReq(token, { action: "DISCARD", notes: "wrong participant" }),
      routeCtx(),
      baseOptions(store, item, {
        writeAudit: writer,
        applyQueueResolutionImpl: apply,
      }),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/application\/json/);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = (await res.json()) as QueueResolveSuccessBody;
    expect(body).toEqual({
      queueItemId: ITEM_ID,
      status: "discarded",
      resolvedAt: NOW.toISOString(),
      resolvedBy: SPECIALIST_ID,
      resolutionSource: "specialist",
    });

    // The UPDATE column set matches the discard branch of Pattern E line 36.
    expect(apply).toHaveBeenCalledTimes(1);
    const updateArg = apply.mock.calls[0]?.[1] as ApplyQueueResolutionInput;
    expect(updateArg).toMatchObject({
      id: ITEM_ID,
      status: "discarded",
      resolutionAction: "DISCARD",
      resolutionSource: "specialist",
      resolvedAt: NOW,
      resolvedBy: SPECIALIST_ID,
      resolutionNotes: "wrong participant",
    });
    expect(updateArg.retryCount).toBeUndefined();
    expect(updateArg.payload).toBeUndefined();

    // Audit pair pre-response, in order: umbrella + per-action sub-row.
    expect(audits).toHaveLength(2);
    expect(audits[0]?.actionType).toBe("offline.action.resolved");
    expect(audits[0]?.outcome).toBe("SUCCESS");
    expect(audits[0]?.channel).toBe("system");
    expect(audits[0]?.participantId).toBe(item.participantId);
    expect(audits[0]?.payloadMetadata).toEqual({
      action: "DISCARD",
      queue_item_id: ITEM_ID,
      queued_action_type: "participants.call.logged",
      notes: "wrong participant",
    });
    expect(audits[1]?.actionType).toBe("offline.action.discarded");
    expect(audits[1]?.outcome).toBe("SUCCESS");
    expect(audits[1]?.payloadMetadata).toEqual(audits[0]?.payloadMetadata);
  });

  it("200 with no notes field on the audit row when notes is omitted", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { audits, writer } = makeAuditCapture();
    const res = await handleQueueResolve(
      resolveReq(token, { action: "DISCARD" }),
      routeCtx(),
      baseOptions(store, makeQueueItem(), { writeAudit: writer }),
    );
    expect(res.status).toBe(200);
    expect(audits).toHaveLength(2);
    expect(audits[0]?.payloadMetadata).not.toHaveProperty("notes");
    expect(audits[1]?.payloadMetadata).not.toHaveProperty("notes");
  });

  it("200 + writes for a `review_required_terminated` row too", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const apply = vi.fn(() => Promise.resolve(1));
    const res = await handleQueueResolve(
      resolveReq(token, { action: "DISCARD" }),
      routeCtx(),
      baseOptions(
        store,
        makeQueueItem({ status: "review_required_terminated" }),
        { applyQueueResolutionImpl: apply },
      ),
    );
    expect(res.status).toBe(200);
    expect(apply).toHaveBeenCalledTimes(1);
  });
});

describe("handleQueueResolve — REASSIGN_RETRY happy path", () => {
  it("200, resets retryCount, merges newOwnerId into payload, resets to pending_sync", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { audits, writer } = makeAuditCapture();
    const apply = vi.fn(() => Promise.resolve(1));
    const item = makeQueueItem({
      retryCount: 3,
      payload: { summary: "called", outcome: "voicemail" },
    });

    const res = await handleQueueResolve(
      resolveReq(token, { action: "REASSIGN_RETRY", newOwnerId: NEW_OWNER_ID }),
      routeCtx(),
      baseOptions(store, item, {
        writeAudit: writer,
        applyQueueResolutionImpl: apply,
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as QueueResolveSuccessBody;
    expect(body.status).toBe("pending_sync");
    expect(body.queueItemId).toBe(ITEM_ID);
    expect(body.resolvedBy).toBe(SPECIALIST_ID);

    expect(apply).toHaveBeenCalledTimes(1);
    const updateArg = apply.mock.calls[0]?.[1] as ApplyQueueResolutionInput;
    expect(updateArg).toMatchObject({
      id: ITEM_ID,
      status: "pending_sync",
      resolutionAction: "REASSIGN_RETRY",
      resolutionSource: "specialist",
      retryCount: 0,
    });
    // Payload is rewritten to carry the new owner; original keys preserved
    // so the eventual flush still sees the queued mutation body.
    expect(updateArg.payload).toEqual({
      summary: "called",
      outcome: "voicemail",
      newOwnerId: NEW_OWNER_ID,
    });

    expect(audits).toHaveLength(2);
    expect(audits[0]?.actionType).toBe("offline.action.resolved");
    expect(audits[1]?.actionType).toBe("offline.action.reassign_retried");
    expect(audits[0]?.payloadMetadata).toMatchObject({
      action: "REASSIGN_RETRY",
      queue_item_id: ITEM_ID,
    });
  });

  it("200 even when the queued payload is null (e.g. a legacy row)", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const apply = vi.fn(() => Promise.resolve(1));
    const res = await handleQueueResolve(
      resolveReq(token, { action: "REASSIGN_RETRY", newOwnerId: NEW_OWNER_ID }),
      routeCtx(),
      baseOptions(store, makeQueueItem({ payload: null }), {
        applyQueueResolutionImpl: apply,
      }),
    );
    expect(res.status).toBe(200);
    const updateArg = apply.mock.calls[0]?.[1] as ApplyQueueResolutionInput;
    expect(updateArg.payload).toEqual({ newOwnerId: NEW_OWNER_ID });
  });
});

describe("handleQueueResolve — ESCALATE_TO_SUPERVISOR happy path", () => {
  it("201 returns escalationId; audit pair carries the id; supervisor_escalations INSERT stubbed", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { audits, writer } = makeAuditCapture();
    const apply = vi.fn(() => Promise.resolve(1));

    const res = await handleQueueResolve(
      resolveReq(token, {
        action: "ESCALATE_TO_SUPERVISOR",
        notes: "specialist requested supervisor review",
      }),
      routeCtx(),
      baseOptions(store, makeQueueItem(), {
        writeAudit: writer,
        applyQueueResolutionImpl: apply,
      }),
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as QueueResolveEscalationBody;
    expect(body).toEqual({
      queueItemId: ITEM_ID,
      escalationId: ESCALATION_ID,
      status: "discarded",
      resolvedAt: NOW.toISOString(),
      resolvedBy: SPECIALIST_ID,
      resolutionSource: "specialist",
      supervisorNotified: true,
    });

    expect(apply).toHaveBeenCalledTimes(1);
    const updateArg = apply.mock.calls[0]?.[1] as ApplyQueueResolutionInput;
    expect(updateArg).toMatchObject({
      id: ITEM_ID,
      status: "discarded",
      resolutionAction: "ESCALATE_TO_SUPERVISOR",
      resolutionSource: "specialist",
      resolutionNotes: "specialist requested supervisor review",
    });

    expect(audits).toHaveLength(2);
    expect(audits[0]?.actionType).toBe("offline.action.resolved");
    expect(audits[0]?.payloadMetadata).toEqual({
      action: "ESCALATE_TO_SUPERVISOR",
      queue_item_id: ITEM_ID,
      queued_action_type: "participants.call.logged",
      notes: "specialist requested supervisor review",
      escalation_id: ESCALATION_ID,
    });
    expect(audits[1]?.actionType).toBe("escalation.created");
    expect(audits[1]?.payloadMetadata).toEqual(audits[0]?.payloadMetadata);
  });
});

// ── idempotency replay (Pattern D) ──────────────────────────────────────────

describe("handleQueueResolve — idempotency replay", () => {
  it("replays the cached body on duplicate Idempotency-Key; handler not re-run", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const item = makeQueueItem();
    const { audits, writer } = makeAuditCapture();
    const find = vi.fn(() => Promise.resolve(item));
    const apply = vi.fn(() => Promise.resolve(1));
    // Share one idempotency store across both calls so the second call's
    // lock acquisition hits the cached row.
    const sharedIdem = makeIdemStore();

    const first = await handleQueueResolve(
      resolveReq(token, { action: "DISCARD" }),
      routeCtx(),
      baseOptions(store, item, {
        writeAudit: writer,
        findQueueItemByIdImpl: find,
        applyQueueResolutionImpl: apply,
        idempotencyStore: sharedIdem,
      }),
    );
    expect(first.status).toBe(200);
    expect(audits).toHaveLength(2);
    const firstBody = await first.clone().json();

    const second = await handleQueueResolve(
      resolveReq(token, { action: "DISCARD" }),
      routeCtx(),
      baseOptions(store, item, {
        writeAudit: writer,
        findQueueItemByIdImpl: find,
        applyQueueResolutionImpl: apply,
        idempotencyStore: sharedIdem,
      }),
    );
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(firstBody);

    // No re-invocation: same audit count, same repo call count.
    expect(audits).toHaveLength(2);
    expect(find).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("422 IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD when payload changes", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const sharedIdem = makeIdemStore();

    const first = await handleQueueResolve(
      resolveReq(token, { action: "DISCARD" }, IDEM_KEY),
      routeCtx(),
      baseOptions(store, makeQueueItem(), { idempotencyStore: sharedIdem }),
    );
    expect(first.status).toBe(200);

    // Second request: same key, different body shape.
    const second = await handleQueueResolve(
      resolveReq(token, { action: "ESCALATE_TO_SUPERVISOR" }, IDEM_KEY),
      routeCtx(),
      baseOptions(store, makeQueueItem(), { idempotencyStore: sharedIdem }),
    );
    expect(second.status).toBe(422);
    expect(((await second.json()) as { code: string }).code).toBe(
      "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD",
    );
  });

  it("two distinct Idempotency-Key values resolve independently", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const sharedIdem = makeIdemStore();
    const find = vi.fn(() => Promise.resolve(makeQueueItem()));
    const apply = vi.fn(() => Promise.resolve(1));

    const first = await handleQueueResolve(
      resolveReq(token, { action: "DISCARD" }, IDEM_KEY),
      routeCtx(),
      baseOptions(store, makeQueueItem(), {
        idempotencyStore: sharedIdem,
        findQueueItemByIdImpl: find,
        applyQueueResolutionImpl: apply,
      }),
    );
    expect(first.status).toBe(200);
    const second = await handleQueueResolve(
      resolveReq(token, { action: "DISCARD" }, IDEM_KEY_2),
      routeCtx(),
      baseOptions(store, makeQueueItem(), {
        idempotencyStore: sharedIdem,
        findQueueItemByIdImpl: find,
        applyQueueResolutionImpl: apply,
      }),
    );
    expect(second.status).toBe(200);
    expect(apply).toHaveBeenCalledTimes(2);
  });
});

// ── repository failures ────────────────────────────────────────────────────

describe("handleQueueResolve — repository failures", () => {
  it("500 INTERNAL_ERROR when the read repository throws", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const find = vi.fn(() => Promise.reject(new Error("pg down")));
    const apply = vi.fn(() =>
      Promise.reject(new Error("apply should not run when read fails")),
    );
    const res = await handleQueueResolve(
      resolveReq(token, { action: "DISCARD" }),
      routeCtx(),
      baseOptions(store, null, {
        findQueueItemByIdImpl: find,
        applyQueueResolutionImpl: apply,
      }),
    );
    expect(res.status).toBe(500);
    expect(((await res.json()) as { code: string }).code).toBe(
      "INTERNAL_ERROR",
    );
    expect(apply).not.toHaveBeenCalled();
  });

  it("500 INTERNAL_ERROR when the write repository throws", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { audits, writer } = makeAuditCapture();
    const apply = vi.fn(() => Promise.reject(new Error("pg write down")));
    const res = await handleQueueResolve(
      resolveReq(token, { action: "DISCARD" }),
      routeCtx(),
      baseOptions(store, makeQueueItem(), {
        writeAudit: writer,
        applyQueueResolutionImpl: apply,
      }),
    );
    expect(res.status).toBe(500);
    // The write failed BEFORE the audit pair fires (audit follows the UPDATE
    // — Pattern B's "mutation + audit committed together" posture).
    expect(audits).toEqual([]);
  });

  it("409 QUEUE_ITEM_NOT_RESOLVABLE when the UPDATE matches 0 rows (lost race)", async () => {
    const { store, seed } = makeStore();
    const token = seed("SPECIALIST");
    const { audits, writer } = makeAuditCapture();
    const apply = vi.fn(() => Promise.resolve(0));
    const res = await handleQueueResolve(
      resolveReq(token, { action: "DISCARD" }),
      routeCtx(),
      baseOptions(store, makeQueueItem(), {
        writeAudit: writer,
        applyQueueResolutionImpl: apply,
      }),
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe(
      "QUEUE_ITEM_NOT_RESOLVABLE",
    );
    expect(audits).toEqual([]);
  });
});
