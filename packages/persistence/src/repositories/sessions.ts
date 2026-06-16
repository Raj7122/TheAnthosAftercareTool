// sessions repository — the Demo-Mode substrate for P1A-04 session middleware
// (ADR-03, ERD §6.8). Lookups are keyed by `token_hash` (SHA-256 of the
// opaque cookie token), never by a plaintext token: a DB dump yields only
// hashes. In Production Mode the table is replaced by Redis with native TTL;
// these functions are the seam the `SessionStore` adapter wraps.

import { eq, lt, sql } from "drizzle-orm";

import type { Role } from "@anthos/auth";

import type { DbOrTx } from "../db/types.js";
import { sessions } from "../schema/index.js";

export type SessionRow = typeof sessions.$inferSelect;

export interface CreateSessionInput {
  // SHA-256 hex of the opaque session token (the cookie carries the plaintext).
  tokenHash: string;
  // Salesforce User Id — opaque varchar(50), foreign-keyless (ERD §6.8).
  specialistId: string;
  role: Role;
  // Absolute-expiry instant, computed by the caller from the configurable
  // absolute timeout (SEC-AUTH-11). Passed explicitly rather than relying on
  // the column's 12-hour DB default so the knob is honored.
  expiresAt: Date;
  ipAddress?: string;
  userAgentHash?: string;
  // The per-specialist Salesforce OAuth refresh token, AES-256-GCM ciphertext
  // (TR-AUTH-3, SEC-AUTH-2). Encrypted by the caller — this layer stores the
  // opaque ciphertext only and never sees the plaintext token or the key.
  sfRefreshTokenEncrypted?: string;
  // The signed-in specialist's own identity from the Salesforce User record
  // (P1B-05), captured at `/auth/callback` and read back by `GET /me` (E-05).
  // Staff identity, not participant PII.
  displayName?: string;
  email?: string;
  timezone?: string;
}

// Insert a new session row. `created_at` / `last_activity_at` take their
// `NOW()` DB defaults. Returns the inserted row.
export async function createSession(
  db: DbOrTx,
  input: CreateSessionInput,
): Promise<SessionRow> {
  const [row] = await db
    .insert(sessions)
    .values({
      tokenHash: input.tokenHash,
      specialistId: input.specialistId,
      role: input.role,
      expiresAt: input.expiresAt,
      // Spread the nullable columns only when supplied — `exactOptionalProperty-
      // Types` forbids handing Drizzle an explicit `undefined`.
      ...(input.ipAddress !== undefined ? { ipAddress: input.ipAddress } : {}),
      ...(input.userAgentHash !== undefined
        ? { userAgentHash: input.userAgentHash }
        : {}),
      ...(input.sfRefreshTokenEncrypted !== undefined
        ? { sfRefreshTokenEncrypted: input.sfRefreshTokenEncrypted }
        : {}),
      ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
      ...(input.email !== undefined ? { email: input.email } : {}),
      ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
    })
    .returning();
  if (row === undefined) {
    throw new Error("createSession: INSERT … RETURNING produced no row.");
  }
  return row;
}

// Resolve a session by the SHA-256 hash of its token. `token_hash` is
// uniquely indexed, so this is an O(1) point lookup. Returns null when no
// row matches (unknown / forged / already-swept token).
export async function getSessionByTokenHash(
  db: DbOrTx,
  tokenHash: string,
): Promise<SessionRow | null> {
  const rows = await db
    .select()
    .from(sessions)
    .where(eq(sessions.tokenHash, tokenHash))
    .limit(1);
  return rows[0] ?? null;
}

// Heartbeat: advance `last_activity_at` so the idle-timeout clock tracks real
// use. Benign session housekeeping — NOT an audited mutation. `now` is passed
// in so it matches the instant the middleware evaluated the session against.
export async function touchSession(
  db: DbOrTx,
  tokenHash: string,
  now: Date,
): Promise<void> {
  await db
    .update(sessions)
    .set({ lastActivityAt: now })
    .where(eq(sessions.tokenHash, tokenHash));
}

// Read the encrypted Salesforce refresh token for a session (P1B-03). Returns
// the AES-256-GCM ciphertext, or null when no row matches OR the column is
// unset — both mean "no refresh token to exchange", which the caller resolves
// to a 401. A dedicated read (not folded into `getSessionByTokenHash`) so the
// Production substrate can route the credential to AWS Secrets Manager while
// the session record itself lives in Redis (TR-AUTH-6).
export async function getSessionRefreshToken(
  db: DbOrTx,
  tokenHash: string,
): Promise<string | null> {
  const rows = await db
    .select({ ciphertext: sessions.sfRefreshTokenEncrypted })
    .from(sessions)
    .where(eq(sessions.tokenHash, tokenHash))
    .limit(1);
  return rows[0]?.ciphertext ?? null;
}

// Apply a session refresh (P1B-03 / E-03): advance `last_activity_at` and, when
// Salesforce rotated the refresh token, overwrite `sf_refresh_token_encrypted`
// — a single UPDATE so the touch and the rotation land atomically (a crash
// cannot leave the idle clock advanced with a stale token, or vice versa).
// `rotatedRefreshTokenEncrypted` is omitted when Salesforce returned no new
// token; the existing ciphertext is then left untouched.
export async function applySessionRefresh(
  db: DbOrTx,
  tokenHash: string,
  now: Date,
  rotatedRefreshTokenEncrypted?: string,
): Promise<void> {
  await db
    .update(sessions)
    .set({
      lastActivityAt: now,
      ...(rotatedRefreshTokenEncrypted !== undefined
        ? { sfRefreshTokenEncrypted: rotatedRefreshTokenEncrypted }
        : {}),
    })
    .where(eq(sessions.tokenHash, tokenHash));
}

// Soft-revoke a session (SEC-AUTH-11 instant revocation; E-04 logout). The row
// is kept — `revoked` / `revoked_at` / `revocation_reason` preserve why and
// when for the audit trail — and the next request short-circuits to 401.
// `sf_refresh_token_encrypted` is cleared in the SAME UPDATE: a revoked session
// must never retain a usable Salesforce credential, so a DB dump of it yields
// no ciphertext. This mirrors the Production substrate, where revocation
// deletes the Redis key and removes the AWS Secrets Manager entry (TR-AUTH-6).
// `reason` is stored in a varchar(100) column; callers keep it short and
// PII-free.
export async function revokeSession(
  db: DbOrTx,
  tokenHash: string,
  reason: string,
): Promise<void> {
  await db
    .update(sessions)
    .set({
      revoked: true,
      revokedAt: sql`NOW()`,
      revocationReason: reason,
      sfRefreshTokenEncrypted: null,
    })
    .where(eq(sessions.tokenHash, tokenHash));
}

// TTL sweep: delete sessions past their absolute expiry. In Production Mode
// Redis evicts keys server-side and this cron is unnecessary. Returns the
// deleted row count. Mirrors `cleanupExpiredIdempotencyKeys`.
export async function cleanupExpiredSessions(db: DbOrTx): Promise<number> {
  const deleted = await db
    .delete(sessions)
    .where(lt(sessions.expiresAt, sql`NOW()`))
    .returning({ id: sessions.id });
  return deleted.length;
}
