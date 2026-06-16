// notification_preferences repository — per-specialist preferences and
// per-session state (ERD v1.4 §6.11). P1B-05 reads a single field, the
// onboarding-tour flag, for `GET /api/v1/me` (E-05); the full preferences
// surface (M-NOTIF / F-15) is built by a later ticket.

import { eq } from "drizzle-orm";

import type { DbOrTx } from "../db/types.js";
import { notificationPreferences } from "../schema/index.js";

// Read the `first_run_completed` onboarding flag for a specialist (drives the
// J-01 onboarding tour, surfaced by `GET /me` per API §7.2.5). Returns `false`
// when the specialist has no `notification_preferences` row yet — the row is
// created lazily on first session start (API §6), so a first-ever `/me` call
// legitimately precedes it. The §7.2.5 "gap-aware default false on first call"
// is therefore this null-row default, not a special case.
export async function getFirstRunCompleted(
  db: DbOrTx,
  specialistId: string,
): Promise<boolean> {
  const rows = await db
    .select({ firstRunCompleted: notificationPreferences.firstRunCompleted })
    .from(notificationPreferences)
    .where(eq(notificationPreferences.specialistId, specialistId))
    .limit(1);
  return rows[0]?.firstRunCompleted ?? false;
}
