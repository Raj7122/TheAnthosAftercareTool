import { sql } from "drizzle-orm";
import {
  check,
  index,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { idempotencyKeys } from "./idempotency_keys.js";

// ERD v1.4 §6.3: server-side mirror of the client Outbox. Only items that
// trip the Review Required state machine (TR-OFFLINE-5a) or exhaust the
// retry budget (TR-OFFLINE-7a) land here — a successful 2xx flush leaves
// no row (the `idempotency_keys` row carries the audit surface, Pattern D).
//
// Client-generated UUID at enqueue (TR-OFFLINE-6a) — no DB default. The same
// `id` survives a reload-then-flush replay so the BFF can deduplicate against
// it. `idempotency_key` is the FK back to the lock taken at first sync
// attempt; ON DELETE SET NULL keeps the queue row visible after the
// idempotency row TTLs out at 24h (idempotency_keys.expires_at).
//
// Substrate shape: the column set survives the AWS RDS swap unchanged —
// queue lifecycle is BFF-driven, not substrate-specific
// ([[feedback_substrate_shape_invariant]]).
export const offlineQueue = pgTable(
  "offline_queue",
  {
    id: uuid("id").primaryKey(),
    specialistId: varchar("specialist_id", { length: 50 }).notNull(),
    participantId: varchar("participant_id", { length: 50 }),
    // Mirrors `audit_log.action_type` vocabulary so a queue row can be
    // correlated to its eventual audit entry by string match.
    actionType: varchar("action_type", { length: 100 }).notNull(),
    payload: jsonb("payload").notNull(),
    idempotencyKey: uuid("idempotency_key").references(
      () => idempotencyKeys.key,
      { onDelete: "set null" },
    ),
    // [v1.2] Trace correlation across the offline_queue → audit_log →
    // supervisor_escalations chain.
    traceId: varchar("trace_id", { length: 100 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    retryCount: smallint("retry_count").notNull().default(0),
    // TR-OFFLINE-5a state machine. The 7 values cover the full lifecycle:
    // pending → in-flight → terminal (completed | failed_max_retries |
    // discarded) plus the two Review Required branches consumed by P3C-08.
    status: varchar("status", { length: 40 }).notNull(),
    errorDetails: jsonb("error_details"),
    resolutionAction: varchar("resolution_action", { length: 50 }),
    // [v1.2] Tracks WHO/WHAT applied the resolution so audit attribution
    // can distinguish auto-retry transitions from human dispositions.
    resolutionSource: varchar("resolution_source", { length: 20 }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    // Pseudo-FK (Salesforce specialist ID); nullable for system resolutions.
    resolvedBy: varchar("resolved_by", { length: 50 }),
    resolutionNotes: text("resolution_notes"),
  },
  (table) => ({
    specialistIdx: index("idx_offline_queue_specialist").on(
      table.specialistId,
      table.status,
      table.createdAt.desc(),
    ),
    // Partial index — supervisor dashboards only need open work.
    statusIdx: index("idx_offline_queue_status")
      .on(table.status, table.createdAt.desc())
      .where(sql`status NOT IN ('completed', 'discarded')`),
    participantIdx: index("idx_offline_queue_participant")
      .on(table.participantId, table.status)
      .where(sql`participant_id IS NOT NULL`),
    idempotencyIdx: index("idx_offline_queue_idempotency")
      .on(table.idempotencyKey)
      .where(sql`idempotency_key IS NOT NULL`),
    traceIdIdx: index("idx_offline_queue_trace_id")
      .on(table.traceId)
      .where(sql`trace_id IS NOT NULL`),
    // Post-pilot analytics on the auto-vs-human resolution mix.
    resolutionSourceIdx: index("idx_offline_queue_resolution_source")
      .on(table.resolutionSource, table.resolvedAt.desc())
      .where(sql`resolution_source IS NOT NULL`),
    retryCountCheck: check(
      "offline_queue_retry_count_check",
      sql`${table.retryCount} >= 0`,
    ),
    statusCheck: check(
      "offline_queue_status_check",
      sql`${table.status} IN ('pending_sync', 'in_flight', 'completed', 'review_required_reassigned', 'review_required_terminated', 'failed_max_retries', 'discarded')`,
    ),
    resolutionActionCheck: check(
      "offline_queue_resolution_action_check",
      sql`${table.resolutionAction} IS NULL OR ${table.resolutionAction} IN ('DISCARD', 'REASSIGN_RETRY', 'ESCALATE_TO_SUPERVISOR')`,
    ),
    resolutionSourceCheck: check(
      "offline_queue_resolution_source_check",
      sql`${table.resolutionSource} IS NULL OR ${table.resolutionSource} IN ('auto_retry', 'auto_max_retries', 'auto_lock_retry', 'specialist', 'supervisor', 'system')`,
    ),
  }),
).enableRLS();

export type OfflineQueueStatus =
  | "pending_sync"
  | "in_flight"
  | "completed"
  | "review_required_reassigned"
  | "review_required_terminated"
  | "failed_max_retries"
  | "discarded";

export type ResolutionAction =
  | "DISCARD"
  | "REASSIGN_RETRY"
  | "ESCALATE_TO_SUPERVISOR";

export type ResolutionSource =
  | "auto_retry"
  | "auto_max_retries"
  | "auto_lock_retry"
  | "specialist"
  | "supervisor"
  | "system";
