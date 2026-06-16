// IdempotencyStore — the substrate seam for Pattern D. The middleware depends
// on this interface, never on Drizzle directly, so the Production-Mode swap
// (Postgres → Redis, per ADR-01) is a new implementation only. The state
// machine and outcome semantics are identical across substrates.

export type IdempotencyStatus = "IN_FLIGHT" | "COMPLETED" | "FAILED_TERMINAL";

// A substrate-independent view of an idempotency_keys row. Only the fields the
// middleware reads — not every column.
export interface IdempotencyRecord {
  readonly key: string;
  readonly specialistId: string;
  readonly status: IdempotencyStatus;
  readonly requestHash: string | null;
  readonly responseStatusCode: number | null;
  readonly responseBody: unknown;
  readonly traceId: string | null;
  readonly expiresAt: Date;
}

export interface AcquireLockInput {
  readonly key: string;
  readonly specialistId: string;
  readonly endpoint: string;
  readonly requestHash: string;
  readonly traceId: string;
}

export interface IdempotencyStore {
  // Atomic lock-acquire. Resolves to the new IN_FLIGHT record when the caller
  // wins the lock, or `null` when the key already exists.
  acquire(input: AcquireLockInput): Promise<IdempotencyRecord | null>;
  get(key: string): Promise<IdempotencyRecord | null>;
  markCompleted(
    key: string,
    responseStatusCode: number,
    responseBody: unknown,
  ): Promise<void>;
  markFailedTerminal(
    key: string,
    responseStatusCode: number,
    responseBody: unknown,
  ): Promise<void>;
  // Removes the row — used both to release a held lock on 5xx/network failure
  // (safe to retry) and to evict a stale expired row.
  delete(key: string): Promise<void>;
  // Daily TTL sweep; resolves to the deleted row count.
  cleanupExpired(): Promise<number>;
}
