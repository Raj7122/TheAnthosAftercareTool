import { sql } from "drizzle-orm";
import {
  check,
  index,
  jsonb,
  pgTable,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

// ERD v1.4 §6.1: append-only tamper-evident operational ledger.
// Demo Mode omits previous_hash / current_hash (ERD §3 substrate-difference
// note + impl plan §1.5 slaughter-list item #3). Production cutover adds the
// SHA-256 hash chain columns and the INSERT-only DB role.
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    timestamp: timestamp("timestamp", { withTimezone: true }).notNull().defaultNow(),
    specialistId: varchar("specialist_id", { length: 50 }).notNull(),
    participantId: varchar("participant_id", { length: 50 }),
    actionType: varchar("action_type", { length: 100 }).notNull(),
    outcome: varchar("outcome", { length: 50 }).notNull(),
    channel: varchar("channel", { length: 30 }),
    salesforceRecordId: varchar("salesforce_record_id", { length: 50 }),
    traceId: varchar("trace_id", { length: 100 }),
    payloadMetadata: jsonb("payload_metadata").notNull().default(sql`'{}'::jsonb`),
  },
  (table) => ({
    outcomeCheck: check(
      "audit_log_outcome_check",
      sql`${table.outcome} IN ('SUCCESS', 'FAILED', 'QUEUED')`,
    ),
    channelCheck: check(
      "audit_log_channel_check",
      sql`${table.channel} IS NULL OR ${table.channel} IN ('phone', 'sms', 'email', 'in_person', 'tablet', 'desktop', 'system')`,
    ),
    timestampIdx: index("idx_audit_log_timestamp").on(table.timestamp.desc()),
    specialistIdx: index("idx_audit_log_specialist").on(
      table.specialistId,
      table.timestamp.desc(),
    ),
    participantIdx: index("idx_audit_log_participant")
      .on(table.participantId, table.timestamp.desc())
      .where(sql`participant_id IS NOT NULL`),
    pendingReconciliationIdx: index("idx_audit_log_pending_reconciliation")
      .on(table.actionType, table.timestamp)
      .where(sql`outcome = 'SUCCESS' AND salesforce_record_id IS NULL`),
    sfRecordIdx: index("idx_audit_log_sf_record")
      .on(table.salesforceRecordId, table.timestamp.desc())
      .where(sql`salesforce_record_id IS NOT NULL`),
    channelIdx: index("idx_audit_log_channel")
      .on(table.channel, table.timestamp.desc())
      .where(sql`channel IS NOT NULL`),
    traceIdIdx: index("idx_audit_log_trace_id")
      .on(table.traceId, table.timestamp.desc())
      .where(sql`trace_id IS NOT NULL`),
  }),
).enableRLS();
