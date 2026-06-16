import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { configuration } from "./configuration.js";

// ERD v1.4 §6.7: field-level change history for `configuration`.
// Insert-only at the DB role level in Production Mode (honored in Demo).
export const configurationAudit = pgTable(
  "configuration_audit",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    timestamp: timestamp("timestamp", { withTimezone: true }).notNull().defaultNow(),
    actorId: varchar("actor_id", { length: 50 }).notNull(),
    fieldPath: varchar("field_path", { length: 200 }).notNull(),
    priorValue: jsonb("prior_value"),
    newValue: jsonb("new_value").notNull(),
    reason: text("reason").notNull(),
    versionFrom: integer("version_from").references(() => configuration.version),
    versionTo: integer("version_to")
      .notNull()
      .references(() => configuration.version),
    approvalMetadata: jsonb("approval_metadata"),
  },
  (table) => ({
    timestampIdx: index("idx_config_audit_timestamp").on(table.timestamp.desc()),
    actorIdx: index("idx_config_audit_actor").on(table.actorId, table.timestamp.desc()),
    fieldIdx: index("idx_config_audit_field").on(table.fieldPath, table.timestamp.desc()),
    versionToIdx: index("idx_config_audit_version_to").on(table.versionTo),
  }),
).enableRLS();
