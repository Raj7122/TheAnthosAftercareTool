// Demo-Mode RateLimiter — Postgres `rate_limits` table via the
// @anthos/persistence repository. Loaded only through a dynamic import (handler
// default-limiter resolution), so the connection side effect in
// @anthos/persistence never enters the static import graph of @anthos/api —
// unit tests that inject a fake limiter stay DB-free.

import { db as defaultDb, repositories } from "@anthos/persistence";
import type { DbClient } from "@anthos/persistence";

import type { RateLimiter } from "./store.js";

export function createPostgresRateLimiter(database: DbClient): RateLimiter {
  return {
    async checkAndConsume(key, windowSeconds) {
      const allowed = await repositories.checkAndConsumeRateLimit(
        database,
        key,
        windowSeconds,
      );
      // When throttled, advise the full window as the retry delay — race-free
      // (no second query) and safely conservative for a `Retry-After` hint.
      return allowed
        ? { allowed: true }
        : { allowed: false, retryAfterSeconds: windowSeconds };
    },
  };
}

export function createDefaultPostgresRateLimiter(): RateLimiter {
  return createPostgresRateLimiter(defaultDb);
}
