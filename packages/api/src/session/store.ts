// SessionStore — the substrate seam for ADR-03 session storage. The session
// middleware and the lifecycle service depend on this interface, never on
// Drizzle directly, so the Production-Mode swap (Postgres `sessions` table →
// Redis with native TTL) is a new implementation only. The middleware contract
// and the service signatures are identical across substrates.
//
// `audit_log` is NOT behind this seam — it stays Postgres in both modes, so
// the service writes audit rows via `@anthos/audit` directly. A session
// mutation and its audit row are therefore two ops in BOTH modes (Redis +
// RDS cannot share a transaction) — keeping the shape substrate-consistent.

import type { Role } from "@anthos/auth";

// Substrate-independent view of a session row — only the fields the middleware
// and service read. `id` is the stable internal identifier; the lookup key is
// the SHA-256 `tokenHash`, never carried back out.
export interface SessionRecord {
  readonly id: string;
  readonly specialistId: string;
  readonly role: Role;
  readonly lastActivityAt: Date;
  readonly expiresAt: Date;
  readonly revoked: boolean;
  // The signed-in specialist's own identity (P1B-05), captured from the
  // Salesforce User record at `/auth/callback` and read back by `GET /me`
  // (E-05). Null on a session minted before the P1B-05 identity capture
  // wired these — the `/me` handler treats a null as a stale session.
  readonly displayName: string | null;
  readonly email: string | null;
  readonly timezone: string | null;
}

export interface CreateSessionInput {
  readonly tokenHash: string;
  readonly specialistId: string;
  readonly role: Role;
  readonly expiresAt: Date;
  readonly ipAddress?: string;
  readonly userAgentHash?: string;
  // The per-specialist Salesforce OAuth refresh token, AES-256-GCM ciphertext
  // (TR-AUTH-3, SEC-AUTH-2). Encrypted by the caller before it reaches this
  // seam. In Production the `SessionStore` impl routes it to AWS Secrets
  // Manager rather than the (Redis) session record.
  readonly sfRefreshTokenEncrypted?: string;
  // The signed-in specialist's own identity from the Salesforce User record
  // (P1B-05) — `/auth/callback` resolves these and passes them through.
  readonly displayName?: string;
  readonly email?: string;
  readonly timezone?: string;
}

export interface SessionStore {
  // Persist a new session. Returns the stored record (with its generated `id`).
  create(input: CreateSessionInput): Promise<SessionRecord>;
  // Resolve a session by the SHA-256 hash of its token. Null when no row
  // matches (unknown / forged / swept token).
  getByTokenHash(tokenHash: string): Promise<SessionRecord | null>;
  // Read the encrypted Salesforce refresh token for a session (P1B-03 token
  // refresh). Null when no row matches or the credential is unset. A dedicated
  // method, not a `SessionRecord` field — in Production the impl routes this to
  // AWS Secrets Manager while `getByTokenHash` hits Redis (TR-AUTH-6).
  getSalesforceRefreshToken(tokenHash: string): Promise<string | null>;
  // Advance `last_activity_at` — the idle-timeout heartbeat.
  touch(tokenHash: string, now: Date): Promise<void>;
  // Apply a session refresh (E-03): advance `last_activity_at` and, when
  // Salesforce rotated the refresh token, overwrite the stored ciphertext —
  // atomically, so a crash cannot leave the touch and the rotation split.
  applySessionRefresh(
    tokenHash: string,
    now: Date,
    rotatedRefreshTokenEncrypted?: string,
  ): Promise<void>;
  // Soft-revoke a session (SEC-AUTH-11 instant revocation; E-04 logout) and
  // wipe its stored Salesforce refresh token — a revoked session must retain
  // no usable credential. In Production the impl deletes the Redis key and
  // removes the AWS Secrets Manager entry; the Demo Postgres impl flips
  // `revoked` and nulls `sf_refresh_token_encrypted` in one UPDATE.
  revoke(tokenHash: string, reason: string): Promise<void>;
  // TTL sweep of absolutely-expired sessions; resolves to the deleted count.
  cleanupExpired(): Promise<number>;
}
