import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  customType,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

// drizzle-orm@0.36 has no first-class `inet` builder; declare one inline
// so generated SQL emits "inet" rather than text. Sessions is the only consumer.
const inet = customType<{ data: string }>({
  dataType() {
    return "inet";
  },
});

// ERD v1.4 §6.8: DB-backed session store for Demo Mode only.
// Production substrate swaps this for Redis with native TTL (ERD §3).
// `trace_id` is deliberately NOT on this table — ERD §3.1 propagation list
// scopes trace_id to audit_log + idempotency_keys + offline_queue +
// supervisor_escalations + ai_requests. Sessions correlation flows through
// audit_log (action_type = 'auth.login' for the originating request).
export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    // SHA-256 (64-char hex) of the opaque 256-bit session token (ADR-03,
    // P1A-04). The cookie carries the plaintext token; the DB carries only its
    // hash, so a DB dump never yields a live token. This is the session lookup
    // key — at the Production substrate swap it becomes the Redis key.
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    specialistId: varchar("specialist_id", { length: 50 }).notNull(),
    role: varchar("role", { length: 30 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW() + INTERVAL '12 hours'`),
    revoked: boolean("revoked").notNull().default(false),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revocationReason: varchar("revocation_reason", { length: 100 }),
    ipAddress: inet("ip_address"),
    userAgentHash: varchar("user_agent_hash", { length: 64 }),
    // [v1.4 patch — P1B-02] The per-specialist Salesforce OAuth refresh token,
    // AES-256-GCM ciphertext (TR-AUTH-3, SEC-AUTH-2 — server-side only, never
    // the cookie/browser). Demo-Mode-only, like the whole `sessions` table:
    // at the Production substrate swap the session moves to Redis and the
    // refresh token to AWS Secrets Manager (TR-AUTH-6), so this column does
    // not survive the swap — the `SessionStore` seam absorbs the difference.
    // Nullable: a session can structurally exist before P1B-02 wires the
    // exchange. ERD §6.8 amended to match.
    sfRefreshTokenEncrypted: text("sf_refresh_token_encrypted"),
    // [v1.4 patch — P1B-05] The signed-in specialist's own identity, captured
    // from the Salesforce User record at `/auth/callback` (E-02) and read back
    // by `GET /api/v1/me` (E-05). Stored here so `/me` is a pure DB read — no
    // Salesforce round-trip mid-session, no refresh-token rotation on a GET.
    // This is STAFF identity, not participant PII (Immutable #1 governs
    // participant data); it sits alongside `ip_address` / `user_agent_hash`.
    // Demo-Mode-only, like the whole table: at the Production substrate swap
    // the session moves to Redis, so these columns do not survive — the
    // `SessionStore` seam absorbs the difference. Nullable: a session can
    // structurally exist before `/auth/callback` wires the values.
    displayName: varchar("display_name", { length: 255 }),
    email: varchar("email", { length: 255 }),
    timezone: varchar("timezone", { length: 50 }),
  },
  (table) => ({
    roleCheck: check(
      "sessions_role_check",
      sql`${table.role} IN ('SPECIALIST', 'SUPERVISOR', 'VP', 'SYSTEM_ADMIN')`,
    ),
    // Unique index — both enforces one row per token hash and serves the
    // O(1) middleware lookup keyed by `hashToken(cookie)`.
    tokenHashIdx: uniqueIndex("idx_sessions_token_hash").on(table.tokenHash),
    specialistIdx: index("idx_sessions_specialist").on(
      table.specialistId,
      table.expiresAt,
    ),
    expiresIdx: index("idx_sessions_expires")
      .on(table.expiresAt)
      .where(sql`revoked = false`),
    // ERD §6.8 specifies `WHERE revoked = false AND expires_at > NOW()`, but
    // Postgres rejects NOW() in index predicates (must be IMMUTABLE; error 42P17).
    // We drop the time clause — the index still narrows on (specialist_id) where
    // revoked = false, and query planners re-apply `expires_at > NOW()` cheaply.
    // ERD patch tracked in the PR description.
    activePerSpecialistIdx: index("idx_sessions_active_per_specialist")
      .on(table.specialistId)
      .where(sql`revoked = false`),
  }),
).enableRLS();
