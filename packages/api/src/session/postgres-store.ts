// Demo-Mode SessionStore — Postgres `sessions` table via the @anthos/persistence
// repository. Loaded only through a dynamic import (middleware default-store
// resolution and the cleanup cron), so the connection side effect in
// @anthos/persistence never enters the static import graph of @anthos/api —
// unit tests that inject a fake store stay DB-free.

import { db as defaultDb, repositories } from "@anthos/persistence";
import type { DbClient } from "@anthos/persistence";
import type { Role } from "@anthos/auth";

import type { SessionRecord, SessionStore } from "./store.js";

// `SessionRow` is exported under the `repositories` namespace, not at the
// package root — derive it from the repository return type (mirrors the
// idempotency Postgres store).
type SessionRow = Awaited<ReturnType<typeof repositories.createSession>>;

function toRecord(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    specialistId: row.specialistId,
    // The `sessions.role` CHECK constraint guarantees one of the four Role
    // values; the column is a plain varchar(30) so the cast is the boundary.
    role: row.role as Role,
    lastActivityAt: row.lastActivityAt,
    expiresAt: row.expiresAt,
    revoked: row.revoked,
    // Identity columns (P1B-05) — nullable; a session minted before the
    // identity-capture migration carries null here.
    displayName: row.displayName,
    email: row.email,
    timezone: row.timezone,
  };
}

export function createPostgresSessionStore(database: DbClient): SessionStore {
  return {
    async create(input) {
      const row = await repositories.createSession(database, input);
      return toRecord(row);
    },
    async getByTokenHash(tokenHash) {
      const row = await repositories.getSessionByTokenHash(database, tokenHash);
      return row === null ? null : toRecord(row);
    },
    async getSalesforceRefreshToken(tokenHash) {
      return repositories.getSessionRefreshToken(database, tokenHash);
    },
    async touch(tokenHash, now) {
      await repositories.touchSession(database, tokenHash, now);
    },
    async applySessionRefresh(tokenHash, now, rotatedRefreshTokenEncrypted) {
      await repositories.applySessionRefresh(
        database,
        tokenHash,
        now,
        rotatedRefreshTokenEncrypted,
      );
    },
    async revoke(tokenHash, reason) {
      await repositories.revokeSession(database, tokenHash, reason);
    },
    async cleanupExpired() {
      return repositories.cleanupExpiredSessions(database);
    },
  };
}

export function createDefaultPostgresStore(): SessionStore {
  return createPostgresSessionStore(defaultDb);
}
