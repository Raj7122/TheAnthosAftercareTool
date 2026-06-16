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

// P1C-03: CDC worker heartbeat + cursor state (ERD §6.9). The Demo-Mode CDC
// polling worker (`packages/api/src/workers/sf-cdc-poll.ts`) reads
// `subscription_states` (per-object ISO-8601 SystemModstamp cursors) at the
// start of each cycle, polls Salesforce REST, and on the way out UPSERTs the
// row with the new cursors plus `last_heartbeat_at = NOW()`. P1C-04 reads the
// row through `readStaleness()` to render the "data may be stale" affordance
// when the worker degrades.
//
// Substrate shape: the Production gRPC Pub/Sub subscriber (SAD §12.2, ADR-06)
// writes the SAME columns — `replay_id` carries the gRPC replay id; for the
// Demo REST poll fallback `subscription_states` carries one ISO-8601 cursor
// per polled SObject. Schema mirrors ERD §6.9 verbatim so the substrate swap
// requires no migration (`[[feedback_substrate_shape_invariant]]`).
export const cdcHealth = pgTable(
  "cdc_health",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Distinguishes worker variants when both a poller and a gRPC subscriber
    // coexist (e.g., during Production cutover). 100 chars per ERD.
    workerId: varchar("worker_id", { length: 100 }).notNull(),
    // Advanced to NOW() on every cycle write. Powers MON-ALERT-11 (Sev-1 when
    // >2 minutes stale) and the P1C-04 staleness read.
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Opaque last-event identifier for forensics. The REST poll fallback sets
    // this to `"<object>:<modstamp>"`; gRPC sets it to the Pub/Sub event id.
    lastEventId: varchar("last_event_id", { length: 100 }),
    // Powers the ERD §6.9 v1.2 72-hour replay-window detection. NULL until
    // the first event lands.
    lastEventReceivedAt: timestamp("last_event_received_at", {
      withTimezone: true,
    }),
    // Coarse health for P1C-04 / MON-ALERT-11. The worker advances this based
    // on consecutive-failure count (see repositories/cdc-health.ts).
    subscriptionStatus: varchar("subscription_status", { length: 30 })
      .notNull()
      .default("CONNECTED"),
    // Per-SObject cursor map for the REST poll fallback:
    //   { "Case_Note__c": "2026-05-22T12:00:00.000Z", "Barriers__c": "...", ... }
    // The Production gRPC subscriber instead carries per-channel replay
    // state here; both shapes pass through Drizzle as opaque jsonb.
    subscriptionStates: jsonb("subscription_states")
      .notNull()
      .default(sql`'{}'::jsonb`),
    // Rolling 24h error counter (best-effort; the cron sweep resets it).
    errorCount24h: smallint("error_count_24h").notNull().default(0),
    // Pub/Sub gRPC replay id (Production). Unused in the Demo REST poll path.
    replayId: varchar("replay_id", { length: 100 }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    workerIdx: index("idx_cdc_health_worker").on(
      table.workerId,
      table.updatedAt.desc(),
    ),
    statusIdx: index("idx_cdc_health_status").on(
      table.subscriptionStatus,
      table.lastHeartbeatAt,
    ),
    statusCheck: check(
      "cdc_health_subscription_status_check",
      sql`${table.subscriptionStatus} IN ('CONNECTED', 'PARTIAL', 'RECONNECTING', 'DISCONNECTED', 'STOPPED')`,
    ),
    workerIdCheck: check(
      "cdc_health_worker_id_check",
      sql`${table.workerId} <> ''`,
    ),
  }),
).enableRLS();

export type SubscriptionStatus =
  | "CONNECTED"
  | "PARTIAL"
  | "RECONNECTING"
  | "DISCONNECTED"
  | "STOPPED";
