import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  jsonb,
  pgTable,
  time,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";

// ERD v1.4 §6.11: per-specialist preferences and per-session state.
// One row per specialist (PK = specialist_id, UPSERT on change).
// `digest_send_local_time` is wall-clock per `timezone` (no TZ on the time column).
export const notificationPreferences = pgTable(
  "notification_preferences",
  {
    specialistId: varchar("specialist_id", { length: 50 }).primaryKey(),
    weeklyDigestEnabled: boolean("weekly_digest_enabled").notNull().default(true),
    dailyDigestEnabled: boolean("daily_digest_enabled").notNull().default(false),
    inAppBadgeEnabled: boolean("in_app_badge_enabled").notNull().default(true),
    digestSendLocalTime: time("digest_send_local_time").notNull().default("08:00:00"),
    timezone: varchar("timezone", { length: 50 }).notNull().default("America/New_York"),
    lastDigestSentAt: timestamp("last_digest_sent_at", { withTimezone: true }),
    firstRunCompleted: boolean("first_run_completed").notNull().default(false),
    firstRunCompletedAt: timestamp("first_run_completed_at", { withTimezone: true }),
    lastSessionEndedAt: timestamp("last_session_ended_at", { withTimezone: true }),
    lastSeenTier1ParticipantIds: jsonb("last_seen_tier_1_participant_ids")
      .notNull()
      .default(sql`'[]'::jsonb`),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: varchar("updated_by", { length: 50 }).notNull(),
  },
  (table) => ({
    weeklyIdx: index("idx_notif_prefs_weekly")
      .on(table.weeklyDigestEnabled, table.timezone)
      .where(sql`weekly_digest_enabled = true`),
    dailyIdx: index("idx_notif_prefs_daily")
      .on(table.dailyDigestEnabled, table.timezone)
      .where(sql`daily_digest_enabled = true`),
    firstRunIdx: index("idx_notif_prefs_first_run")
      .on(table.firstRunCompleted)
      .where(sql`first_run_completed = false`),
  }),
).enableRLS();
