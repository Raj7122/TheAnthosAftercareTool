import { pgTable, timestamp, varchar } from "drizzle-orm/pg-core";

// ERD v1.4 patch (P1B-03): application-level rate-limit substrate for Demo
// Mode. One row per `<scope>:<subject>` key; the check-and-consume is a single
// atomic UPSERT (see repositories/rate-limits.ts). First consumer: E-03
// `POST /api/v1/auth/refresh` — 1 request per 5s per specialist (API §6, §11.3).
//
// Demo-Mode-only artifact: at the Production substrate swap this table is
// replaced by a Redis token bucket (API §11.3) behind the `RateLimiter` seam,
// so it is dropped, not migrated — mirroring `sessions` / `idempotency_keys`.
// Not enumerated in ERD v1.4; the ERD patch is tracked in the PR description.
export const rateLimits = pgTable("rate_limits", {
  // `<scope>:<subject>` — e.g. `auth.refresh:<specialistId>`. varchar(150)
  // leaves headroom for a 50-char Salesforce id plus a scope prefix.
  key: varchar("key", { length: 150 }).primaryKey(),
  // The instant the most recent allowed request was consumed. The window
  // check compares this against NOW() minus the configured window.
  lastRequestAt: timestamp("last_request_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
}).enableRLS();
