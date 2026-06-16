import { hashToken, loadSessionConfig, mintToken } from "@anthos/auth";
import type { Role } from "@anthos/auth";
import type { DbOrTx } from "@anthos/persistence";
import { describe, expect, it } from "vitest";

import { refreshSession, revokeSession, startSession } from "../../src/session/service.js";
import type { CreateSessionInput, SessionRecord, SessionStore } from "../../src/session/store.js";

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const CONFIG = loadSessionConfig({}); // 12-h absolute timeout

interface FakeSession {
  id: string;
  tokenHash: string;
  specialistId: string;
  role: Role;
  lastActivityAt: Date;
  expiresAt: Date;
  revoked: boolean;
  revocationReason: string | null;
  sfRefreshTokenEncrypted: string | null;
}

interface RefreshCall {
  tokenHash: string;
  now: Date;
  rotatedRefreshTokenEncrypted: string | undefined;
}

function toRecord(s: FakeSession): SessionRecord {
  return {
    id: s.id,
    specialistId: s.specialistId,
    role: s.role,
    lastActivityAt: s.lastActivityAt,
    expiresAt: s.expiresAt,
    revoked: s.revoked,
    displayName: null,
    email: null,
    timezone: null,
  };
}

function makeStore(): {
  store: SessionStore;
  rows: Map<string, FakeSession>;
  touched: string[];
  refreshCalls: RefreshCall[];
  createInputs: CreateSessionInput[];
} {
  const rows = new Map<string, FakeSession>();
  const touched: string[] = [];
  const refreshCalls: RefreshCall[] = [];
  const createInputs: CreateSessionInput[] = [];
  const store: SessionStore = {
    create(input) {
      createInputs.push(input);
      const row: FakeSession = {
        id: `session-${rows.size + 1}`,
        tokenHash: input.tokenHash,
        specialistId: input.specialistId,
        role: input.role,
        lastActivityAt: new Date(),
        expiresAt: input.expiresAt,
        revoked: false,
        revocationReason: null,
        sfRefreshTokenEncrypted: input.sfRefreshTokenEncrypted ?? null,
      };
      rows.set(input.tokenHash, row);
      return Promise.resolve(toRecord(row));
    },
    getByTokenHash(tokenHash) {
      const row = rows.get(tokenHash);
      return Promise.resolve(row ? toRecord(row) : null);
    },
    getSalesforceRefreshToken(tokenHash) {
      return Promise.resolve(rows.get(tokenHash)?.sfRefreshTokenEncrypted ?? null);
    },
    touch(tokenHash, now) {
      touched.push(tokenHash);
      const row = rows.get(tokenHash);
      if (row) {
        row.lastActivityAt = now;
      }
      return Promise.resolve();
    },
    applySessionRefresh(tokenHash, now, rotatedRefreshTokenEncrypted) {
      refreshCalls.push({ tokenHash, now, rotatedRefreshTokenEncrypted });
      const row = rows.get(tokenHash);
      if (row) {
        row.lastActivityAt = now;
        if (rotatedRefreshTokenEncrypted !== undefined) {
          row.sfRefreshTokenEncrypted = rotatedRefreshTokenEncrypted;
        }
      }
      return Promise.resolve();
    },
    revoke(tokenHash, reason) {
      const row = rows.get(tokenHash);
      if (row) {
        row.revoked = true;
        row.revocationReason = reason;
        // Mirror the real Postgres repo: revoking a session wipes its stored
        // Salesforce refresh token — a revoked session retains no credential.
        row.sfRefreshTokenEncrypted = null;
      }
      return Promise.resolve();
    },
    cleanupExpired() {
      return Promise.resolve(0);
    },
  };
  return { store, rows, touched, refreshCalls, createInputs };
}

// Minimal stand-in for the Drizzle insert chain `writeAuditEntry` drives — no
// live Postgres. The real `writeAuditEntry` (incl. its no-PII assertion) runs.
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

function seed(
  rows: Map<string, FakeSession>,
  opts: {
    lastActivityAt?: Date;
    expiresAt?: Date;
    revoked?: boolean;
    sfRefreshTokenEncrypted?: string | null;
  } = {},
): { token: string; tokenHash: string } {
  const token = mintToken();
  const tokenHash = hashToken(token);
  rows.set(tokenHash, {
    id: `session-${rows.size + 1}`,
    tokenHash,
    specialistId: "S-1",
    role: "SPECIALIST",
    lastActivityAt: opts.lastActivityAt ?? new Date(),
    expiresAt: opts.expiresAt ?? new Date(Date.now() + 11 * HOUR),
    revoked: opts.revoked ?? false,
    revocationReason: null,
    sfRefreshTokenEncrypted:
      opts.sfRefreshTokenEncrypted === undefined
        ? "old-ciphertext-placeholder"
        : opts.sfRefreshTokenEncrypted,
  });
  return { token, tokenHash };
}

// ── startSession ───────────────────────────────────────────────────────────

describe("startSession", () => {
  it("mints a 256-bit token, persists its hash, returns sessionId + expiresAt", async () => {
    const { store, rows } = makeStore();
    const { db } = makeFakeDb();
    const before = Date.now();

    const result = await startSession(store, db, CONFIG, {
      specialistId: "S-1",
      role: "SPECIALIST",
    });

    expect(Buffer.from(result.token, "base64url")).toHaveLength(32);
    expect(rows.get(hashToken(result.token))?.id).toBe(result.sessionId);
    // expiresAt tracks the configurable 12-h absolute timeout.
    expect(result.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 43200 * 1000);
    expect(result.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 43200 * 1000 + 5000);
  });

  it("writes one auth.session_start audit row carrying the trace_id", async () => {
    const { store } = makeStore();
    const { db, inserted } = makeFakeDb();

    const result = await startSession(store, db, CONFIG, {
      specialistId: "S-1",
      role: "SPECIALIST",
      traceId: "trace-start-1",
    });

    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.actionType).toBe("auth.session_start");
    expect(inserted[0]?.outcome).toBe("SUCCESS");
    expect(inserted[0]?.specialistId).toBe("S-1");
    expect(inserted[0]?.traceId).toBe("trace-start-1");
    expect(inserted[0]?.payloadMetadata).toEqual({
      session_id: result.sessionId,
      role: "SPECIALIST",
    });
  });

  it("passes the encrypted SF refresh token through to the store, never to the audit", async () => {
    const { store, createInputs } = makeStore();
    const { db, inserted } = makeFakeDb();
    const sfRefreshTokenEncrypted = "ciphertext-placeholder-base64url";

    await startSession(store, db, CONFIG, {
      specialistId: "S-1",
      role: "SPECIALIST",
      sfRefreshTokenEncrypted,
    });

    expect(createInputs[0]?.sfRefreshTokenEncrypted).toBe(sfRefreshTokenEncrypted);
    // The refresh-token ciphertext is server-side state — never audit metadata.
    expect(JSON.stringify(inserted[0]?.payloadMetadata)).not.toContain(
      sfRefreshTokenEncrypted,
    );
  });

  it("stores ip + user-agent hash on the session row, never in the audit payload", async () => {
    const { store, createInputs } = makeStore();
    const { db, inserted } = makeFakeDb();
    const userAgentHash = "a".repeat(64);

    await startSession(store, db, CONFIG, {
      specialistId: "S-1",
      role: "SPECIALIST",
      ipAddress: "203.0.113.7",
      userAgentHash,
    });

    expect(createInputs[0]?.ipAddress).toBe("203.0.113.7");
    expect(createInputs[0]?.userAgentHash).toBe(userAgentHash);
    // The audit payload (SEC-AUDIT-4) carries neither the IP nor the UA hash —
    // `writeAuditEntry`'s assertNoPii would have thrown if it did.
    const payload = JSON.stringify(inserted[0]?.payloadMetadata);
    expect(payload).not.toContain("203.0.113.7");
    expect(payload).not.toContain(userAgentHash);
  });
});

// ── refreshSession ─────────────────────────────────────────────────────────

describe("refreshSession", () => {
  it("refreshes an active session — applies the refresh and audits auth.session_refresh", async () => {
    const { store, rows, refreshCalls } = makeStore();
    const { db, inserted } = makeFakeDb();
    const { tokenHash } = seed(rows);

    const result = await refreshSession(store, db, tokenHash, "trace-refresh-1");

    expect(result).not.toBeNull();
    expect(refreshCalls.map((c) => c.tokenHash)).toContain(tokenHash);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.actionType).toBe("auth.session_refresh");
    expect(inserted[0]?.traceId).toBe("trace-refresh-1");
  });

  it("audits the session id and role (AC-05) — no PII", async () => {
    const { store, rows } = makeStore();
    const { db, inserted } = makeFakeDb();
    const { tokenHash } = seed(rows);
    const sessionId = rows.get(tokenHash)?.id;

    await refreshSession(store, db, tokenHash, "trace-refresh-role");

    expect(inserted[0]?.payloadMetadata).toEqual({
      session_id: sessionId,
      role: "SPECIALIST",
    });
  });

  it("refreshes an idle-expired session still within the absolute window", async () => {
    const { store, rows } = makeStore();
    const { db, inserted } = makeFakeDb();
    const { tokenHash } = seed(rows, {
      lastActivityAt: new Date(Date.now() - 60 * MINUTE),
      expiresAt: new Date(Date.now() + HOUR),
    });

    expect(await refreshSession(store, db, tokenHash)).not.toBeNull();
    expect(inserted).toHaveLength(1);
  });

  it("persists a rotated refresh token, overwriting the stored ciphertext", async () => {
    const { store, rows, refreshCalls } = makeStore();
    const { db } = makeFakeDb();
    const { tokenHash } = seed(rows, {
      sfRefreshTokenEncrypted: "old-ciphertext-placeholder",
    });

    await refreshSession(store, db, tokenHash, "trace-rotate", {
      rotatedRefreshTokenEncrypted: "new-ciphertext-placeholder",
    });

    expect(refreshCalls[0]?.rotatedRefreshTokenEncrypted).toBe(
      "new-ciphertext-placeholder",
    );
    expect(rows.get(tokenHash)?.sfRefreshTokenEncrypted).toBe(
      "new-ciphertext-placeholder",
    );
  });

  it("leaves the stored refresh token untouched when Salesforce did not rotate", async () => {
    const { store, rows, refreshCalls } = makeStore();
    const { db } = makeFakeDb();
    const { tokenHash } = seed(rows, {
      sfRefreshTokenEncrypted: "old-ciphertext-placeholder",
    });

    await refreshSession(store, db, tokenHash, "trace-no-rotate");

    expect(refreshCalls[0]?.rotatedRefreshTokenEncrypted).toBeUndefined();
    expect(rows.get(tokenHash)?.sfRefreshTokenEncrypted).toBe(
      "old-ciphertext-placeholder",
    );
  });

  it("never writes the rotated refresh token into the audit payload", async () => {
    const { store, rows } = makeStore();
    const { db, inserted } = makeFakeDb();
    const { tokenHash } = seed(rows);

    await refreshSession(store, db, tokenHash, "trace-rotate-audit", {
      rotatedRefreshTokenEncrypted: "secret-rotated-ciphertext",
    });

    expect(JSON.stringify(inserted[0]?.payloadMetadata)).not.toContain(
      "secret-rotated-ciphertext",
    );
  });

  it("returns null and writes no audit row for a revoked session", async () => {
    const { store, rows } = makeStore();
    const { db, inserted } = makeFakeDb();
    const { tokenHash } = seed(rows, { revoked: true });

    expect(await refreshSession(store, db, tokenHash)).toBeNull();
    expect(inserted).toHaveLength(0);
  });

  it("returns null and writes no audit row past the absolute timeout", async () => {
    const { store, rows } = makeStore();
    const { db, inserted } = makeFakeDb();
    const { tokenHash } = seed(rows, { expiresAt: new Date(Date.now() - 1000) });

    expect(await refreshSession(store, db, tokenHash)).toBeNull();
    expect(inserted).toHaveLength(0);
  });
});

// ── revokeSession ──────────────────────────────────────────────────────────

describe("revokeSession", () => {
  it("soft-revokes the session, wipes the SF refresh token, audits auth.session_end", async () => {
    const { store, rows } = makeStore();
    const { db, inserted } = makeFakeDb();
    const { tokenHash } = seed(rows, { sfRefreshTokenEncrypted: "old-ciphertext" });
    const sessionId = rows.get(tokenHash)?.id;

    const ok = await revokeSession(store, db, tokenHash, "logout", "trace-revoke-1");

    expect(ok).toBe(true);
    expect(rows.get(tokenHash)?.revoked).toBe(true);
    expect(rows.get(tokenHash)?.revocationReason).toBe("logout");
    // Immutable #3 — a revoked session retains no usable Salesforce credential.
    expect(rows.get(tokenHash)?.sfRefreshTokenEncrypted).toBeNull();
    expect(inserted[0]?.actionType).toBe("auth.session_end");
    expect(inserted[0]?.traceId).toBe("trace-revoke-1");
    expect(inserted[0]?.payloadMetadata).toEqual({
      session_id: sessionId,
      role: "SPECIALIST",
      reason: "logout",
    });
  });

  it("is a no-op for a missing session — returns false, writes no audit", async () => {
    const { store } = makeStore();
    const { db, inserted } = makeFakeDb();

    expect(await revokeSession(store, db, hashToken(mintToken()), "logout")).toBe(false);
    expect(inserted).toHaveLength(0);
  });

  it("is a no-op for an already-revoked session — returns false, writes no duplicate audit", async () => {
    const { store, rows } = makeStore();
    const { db, inserted } = makeFakeDb();
    const { tokenHash } = seed(rows, { revoked: true });

    // A second logout (different Idempotency-Key, or a manual click after a
    // parent-frame revoke per BR-05) must NOT emit a duplicate auth.session_end.
    expect(await revokeSession(store, db, tokenHash, "logout", "trace-dup")).toBe(false);
    expect(inserted).toHaveLength(0);
  });
});
