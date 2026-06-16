// RateLimiter — the substrate seam for application-level rate limiting (API
// §6 / §11.3). The endpoint handlers depend on this interface, never on the
// Postgres `rate_limits` table directly, so the Production-Mode swap (Postgres
// → Redis token bucket) is a new implementation only — the handler contract is
// identical across substrates, mirroring `SessionStore` / `IdempotencyStore`.

export interface RateLimitResult {
  // `true` when the request is within budget and has been consumed; `false`
  // when a prior request inside the window throttles this one.
  readonly allowed: boolean;
  // Advisory seconds to wait before retrying — populated only when throttled.
  // Feeds the `Retry-After` response header.
  readonly retryAfterSeconds?: number;
}

export interface RateLimiter {
  // Atomically record a request against `key` (a `<scope>:<subject>` string,
  // e.g. `auth.refresh:<specialistId>`) and report whether it is allowed under
  // a fixed window of `windowSeconds`. The check and the consume are one
  // operation — concurrent callers cannot both be allowed past the limit.
  checkAndConsume(key: string, windowSeconds: number): Promise<RateLimitResult>;
}
