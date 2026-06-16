import { sql } from "drizzle-orm";
import {
  check,
  index,
  jsonb,
  pgTable,
  smallint,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

// ERD v1.4 §6.2: idempotency middleware state cache (TR-WRITE-2a/b/c).
// 24-hour TTL state machine: IN_FLIGHT → COMPLETED | FAILED_TERMINAL.
// `trace_id` (v1.2) propagates the inbound request's correlation ID so
// downstream audit/queue/escalation rows can be joined back to the lock.
export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    key: uuid("key").primaryKey(),
    specialistId: varchar("specialist_id", { length: 50 }).notNull(),
    endpoint: varchar("endpoint", { length: 200 }).notNull(),
    requestHash: varchar("request_hash", { length: 64 }),
    status: varchar("status", { length: 20 }).notNull(),
    responseStatusCode: smallint("response_status_code"),
    responseBody: jsonb("response_body"),
    traceId: varchar("trace_id", { length: 100 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW() + INTERVAL '24 hours'`),
  },
  (table) => ({
    statusCheck: check(
      "idempotency_keys_status_check",
      sql`${table.status} IN ('IN_FLIGHT', 'COMPLETED', 'FAILED_TERMINAL')`,
    ),
    expiresIdx: index("idx_idempotency_expires").on(table.expiresAt),
    specialistIdx: index("idx_idempotency_specialist").on(
      table.specialistId,
      table.createdAt.desc(),
    ),
    traceIdIdx: index("idx_idempotency_trace_id")
      .on(table.traceId)
      .where(sql`trace_id IS NOT NULL`),
  }),
).enableRLS();
