// Application-level rate limiting (API §6 / §11.3). Public surface of the
// ratelimit module. The Postgres limiter is intentionally NOT re-exported: it
// is reached only via dynamic import, keeping the DB connection side effect out
// of the static import graph of @anthos/api.

export type { RateLimiter, RateLimitResult } from "./store.js";
export { rateLimitErrorResponse } from "./responses.js";
