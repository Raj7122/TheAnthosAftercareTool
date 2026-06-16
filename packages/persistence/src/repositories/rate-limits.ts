// rate_limits repository — the Demo-Mode substrate for application-level
// per-specialist rate limiting (API §6 / §11.3). `checkAndConsumeRateLimit` is
// a single atomic `INSERT … ON CONFLICT DO UPDATE … WHERE` — a SELECT-then-
// UPDATE would race two concurrent requests past the limit.
//
// No cleanup cron: the table is bounded by (active specialists × rate-limited
// scopes) — a handful of rows that are overwritten in place, never appended.
// In Production Mode a Redis token bucket (API §11.3) replaces this table
// behind the `RateLimiter` seam.

import { sql } from "drizzle-orm";

import type { DbOrTx } from "../db/types.js";
import { rateLimits } from "../schema/index.js";

// Atomically record a request against `key` if the fixed window has elapsed.
// Returns `true` when the request is allowed (the window had elapsed — or this
// is the first request for the key — and `last_request_at` was advanced to
// NOW()); `false` when a prior request inside the window throttles this one.
//
// Mechanics: the INSERT wins for a never-seen key. On conflict the UPDATE fires
// only when `last_request_at` predates the window, so `RETURNING` yields a row
// exactly when the request is allowed — and the timestamp advance and the
// allow decision are the same statement, leaving no race window.
// `make_interval(secs => N)` is PostgreSQL named-parameter call notation (PG
// 12+) — it builds an interval from the integer window without string interp.
export async function checkAndConsumeRateLimit(
  db: DbOrTx,
  key: string,
  windowSeconds: number,
): Promise<boolean> {
  const rows = await db
    .insert(rateLimits)
    .values({ key })
    .onConflictDoUpdate({
      target: rateLimits.key,
      set: { lastRequestAt: sql`NOW()` },
      setWhere: sql`${rateLimits.lastRequestAt} < NOW() - make_interval(secs => ${windowSeconds})`,
    })
    .returning({ key: rateLimits.key });
  return rows.length > 0;
}
