// Session lifecycle service. These functions are the substrate the P1B OAuth
// endpoints consume — `/auth/callback` calls `startSession`, `/auth/refresh`
// calls `refreshSession`, `/auth/logout` calls `revokeSession`. P1A-04 builds
// and unit-tests them; P1B wires them to routes.
//
// Each writes the audited lifecycle event via the P1A-02 writer, threading the
// request's `traceId` so the audit row joins the correlation chain (P1A-06).
// The audit payload carries the session id and role — both PII-safe.
//
// Audit/mutation are NOT transactional: a session lives in Redis and the
// audit_log in RDS at Production cutover, so they cannot share a transaction
// — the shape is kept identical in Demo (see store.ts). The failure mode is
// one-directional and named at each callsite below: a failed audit write
// surfaces as a thrown error AFTER the session mutation has landed.

import { writeAuditEntry } from "@anthos/audit";
import { hashToken, mintToken } from "@anthos/auth";
import type { Role, SessionConfig } from "@anthos/auth";
import type { DbOrTx } from "@anthos/persistence";

import type { SessionRecord, SessionStore } from "./store.js";

// Matches the `sessions.revocation_reason` varchar(100) column width (ERD §6.8).
const MAX_REVOCATION_REASON_LENGTH = 100;

export interface StartSessionInput {
  readonly specialistId: string;
  readonly role: Role;
  readonly ipAddress?: string;
  readonly userAgentHash?: string;
  // The per-specialist Salesforce OAuth refresh token, AES-256-GCM ciphertext
  // (TR-AUTH-3, SEC-AUTH-2). The caller (`/auth/callback`) owns the encryption
  // key and encrypts before calling — this service stores opaque ciphertext
  // and never handles the plaintext token or the key.
  readonly sfRefreshTokenEncrypted?: string;
  // The signed-in specialist's own identity from the Salesforce User record
  // (P1B-05). `/auth/callback` resolves these alongside the role; persisted on
  // the session row so `GET /me` (E-05) is a pure DB read.
  readonly displayName?: string;
  readonly email?: string;
  readonly timezone?: string;
  // Inbound request correlation id — stamped on the auth.session_start row.
  readonly traceId?: string;
}

export interface StartedSession {
  // Plaintext token — the caller delivers it in the HttpOnly `anthos_session`
  // cookie via `serializeSessionCookie`. It is never persisted.
  readonly token: string;
  readonly sessionId: string;
  readonly expiresAt: Date;
}

// Issue a session: mint an opaque 256-bit token, persist its SHA-256 hash, and
// write the `auth.session_start` audit row. `expiresAt` is computed from the
// configurable absolute timeout (SEC-AUTH-11), not the column default, so the
// knob is honored.
//
// The audit payload is `{ session_id, role }`. API §7.2.2 prescribes
// `{ ipAddressHash, userAgentHash }` here, but SEC-AUDIT-4's `assertNoPii`
// rejects keys containing "address"/"hash" and 64-hex values — the spec is
// internally inconsistent. P1B-02 reconciled this: the IP and user-agent hash
// are stored on the `sessions` row (their correct home), and the payload
// carries the no-PII-safe `{ session_id, role }` the P1B-02 ticket AC asks
// for. The API-spec payload shape is flagged in the P1B-02 PR body.
//
// Failure mode: if `writeAuditEntry` throws, the session row already exists —
// the caller sees the error and must treat the start as failed.
export async function startSession(
  store: SessionStore,
  db: DbOrTx,
  config: SessionConfig,
  input: StartSessionInput,
): Promise<StartedSession> {
  const token = mintToken();
  const expiresAt = new Date(Date.now() + config.absoluteTimeoutSeconds * 1000);

  // Immutable #5 is "audit BEFORE response" — `writeAuditEntry` below is
  // awaited before this function returns, so the caller's response always
  // trails the audit row. It is NOT "audit before mutation": the session store
  // (Redis at Production) and `audit_log` (RDS) cannot share a transaction, so
  // the session row necessarily lands first. Accepted cross-store deviation —
  // see the file header and the failure-mode note above.
  const session = await store.create({
    tokenHash: hashToken(token),
    specialistId: input.specialistId,
    role: input.role,
    expiresAt,
    // Spread the optional fields only when supplied — `exactOptionalProperty-
    // Types` forbids an explicit `undefined`.
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
  });

  await writeAuditEntry(db, {
    specialistId: input.specialistId,
    actionType: "auth.session_start",
    outcome: "SUCCESS",
    payloadMetadata: { session_id: session.id, role: input.role },
    ...(input.traceId !== undefined ? { traceId: input.traceId } : {}),
  });

  return { token, sessionId: session.id, expiresAt };
}

// Extra inputs for a session refresh beyond the idle-clock touch.
export interface RefreshSessionOptions {
  // The Salesforce-rotated refresh token, AES-256-GCM ciphertext. `/auth/refresh`
  // supplies it when Salesforce returned a new refresh token (SEC-AUTH-6); the
  // store overwrites `sf_refresh_token_encrypted` atomically with the idle-clock
  // touch. Omitted when Salesforce did not rotate — the existing token stands.
  readonly rotatedRefreshTokenEncrypted?: string;
}

// Refresh a session — the session-side of `/auth/refresh` (E-03). Advances the
// idle clock and, when Salesforce rotated the OAuth refresh token, persists the
// new ciphertext in the SAME store call so the touch and the rotation cannot
// land split. A session that is idle-expired but still within the 12h absolute
// window IS refreshable; a revoked or absolutely-expired one is not. Writes
// `auth.session_refresh`. Returns the refreshed record, or null when the
// session cannot be refreshed (caller → 401).
export async function refreshSession(
  store: SessionStore,
  db: DbOrTx,
  tokenHash: string,
  traceId?: string,
  options: RefreshSessionOptions = {},
): Promise<SessionRecord | null> {
  const now = new Date();
  const session = await store.getByTokenHash(tokenHash);
  if (session === null || session.revoked) {
    return null;
  }
  if (now.getTime() >= session.expiresAt.getTime()) {
    return null; // past the absolute cap — not refreshable
  }

  await store.applySessionRefresh(
    tokenHash,
    now,
    options.rotatedRefreshTokenEncrypted,
  );
  await writeAuditEntry(db, {
    specialistId: session.specialistId,
    actionType: "auth.session_refresh",
    outcome: "SUCCESS",
    payloadMetadata: { session_id: session.id, role: session.role },
    ...(traceId !== undefined ? { traceId } : {}),
  });
  return { ...session, lastActivityAt: now };
}

// Revoke a session — logout (E-04), or SEC-AUTH-11 instant revocation.
// Soft-revokes the row, wipes the stored Salesforce refresh token (the
// `SessionStore.revoke` seam), and writes `auth.session_end`. Idempotent: a
// missing OR already-revoked session is a no-op returning false, so a replayed
// logout, a double-click, or a manual logout after a parent-frame revoke
// (BR-05) never errors AND never writes a duplicate `auth.session_end`.
// `reason` is a short controlled string (e.g. "logout", "idle_timeout") — it is
// stored on the row and echoed in the audit payload, so it must stay PII-free;
// it is truncated to the column width as a defensive guard.
//
// Failure mode: if `writeAuditEntry` throws, the session is already revoked —
// a one-directional risk (a legitimate revocation lands un-audited, never a
// ghost audit row).
export async function revokeSession(
  store: SessionStore,
  db: DbOrTx,
  tokenHash: string,
  reason: string,
  traceId?: string,
): Promise<boolean> {
  const session = await store.getByTokenHash(tokenHash);
  if (session === null || session.revoked) {
    return false;
  }
  const safeReason = reason.slice(0, MAX_REVOCATION_REASON_LENGTH);
  await store.revoke(tokenHash, safeReason);
  // Payload carries `session_id` + `role` (consistent with auth.session_start /
  // _refresh) plus the `reason` that distinguishes a logout from an idle-timeout
  // or admin revocation. All three are PII-safe (`role` is an enum); the trace
  // id rides the dedicated `traceId` audit column.
  await writeAuditEntry(db, {
    specialistId: session.specialistId,
    actionType: "auth.session_end",
    outcome: "SUCCESS",
    payloadMetadata: { session_id: session.id, role: session.role, reason: safeReason },
    ...(traceId !== undefined ? { traceId } : {}),
  });
  return true;
}
