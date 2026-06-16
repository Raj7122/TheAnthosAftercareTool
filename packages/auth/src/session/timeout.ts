// Pure session timeout evaluation. The middleware loads a session row, calls
// `evaluateSession`, and short-circuits to 401 on anything but `active`.
//
// Two independent clocks (ADR-03 / SEC-AUTH-5 / SEC-AUTH-11):
//  - absolute timeout — encoded in the `expires_at` column, set once at
//    session creation; read-time evaluation just compares `now` against it.
//  - idle timeout — NOT a column; computed from `last_activity_at` plus the
//    configured idle window, so retuning GAP-11 needs no data migration.
//
// Pure, I/O-free, dependency-free.

export type SessionStatus = "active" | "idle_expired" | "absolute_expired" | "revoked";

// The minimal session shape this evaluation reads — a subset of the
// `sessions` row, so callers are not coupled to the full Drizzle type.
export interface SessionTimestamps {
  readonly lastActivityAt: Date;
  readonly expiresAt: Date;
  readonly revoked: boolean;
}

export interface SessionEvaluation {
  readonly status: SessionStatus;
  // The instant the session lapsed — set for `idle_expired` / `absolute_expired`
  // (feeds the `AUTH_SESSION_EXPIRED` response detail). Null otherwise.
  readonly expiredAt: Date | null;
}

// Evaluate a session against the current time. Precedence: a revoked session
// is invalid regardless of clocks; the absolute cap outranks the idle cap so a
// 12-h-old session reads as `absolute_expired` even if just used.
export function evaluateSession(
  session: SessionTimestamps,
  now: Date,
  config: { readonly idleTimeoutSeconds: number },
): SessionEvaluation {
  if (session.revoked) {
    return { status: "revoked", expiredAt: null };
  }

  if (now.getTime() >= session.expiresAt.getTime()) {
    return { status: "absolute_expired", expiredAt: session.expiresAt };
  }

  const idleDeadline = new Date(
    session.lastActivityAt.getTime() + config.idleTimeoutSeconds * 1000,
  );
  if (now.getTime() >= idleDeadline.getTime()) {
    return { status: "idle_expired", expiredAt: idleDeadline };
  }

  return { status: "active", expiredAt: null };
}
