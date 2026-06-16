// idempotency_keys repository — the Demo-Mode substrate for Pattern D's BFF
// idempotency middleware (TR-WRITE-2a/b/c, ARC-09). Lock acquisition is the
// atomic `INSERT … ON CONFLICT (key) DO NOTHING RETURNING *` mandated by
// TR-WRITE-2b; SELECT-then-INSERT is race-vulnerable and forbidden.

import { eq, lt, sql } from "drizzle-orm";

import type { DbOrTx } from "../db/types.js";
import { idempotencyKeys } from "../schema/index.js";

export type IdempotencyKeyRow = typeof idempotencyKeys.$inferSelect;

export interface AcquireIdempotencyLockInput {
  key: string;
  specialistId: string;
  endpoint: string;
  requestHash: string;
  traceId: string;
}

// Atomic lock-acquire. Returns the inserted row when the caller wins the lock,
// or `null` when the key already exists (the caller must then resolve the
// duplicate against the existing row). `expires_at` and `created_at` are left
// to their DB defaults — `expires_at = NOW() + INTERVAL '24 hours'` satisfies
// the TR-WRITE-2c TTL without the application computing it.
export async function acquireIdempotencyLock(
  db: DbOrTx,
  input: AcquireIdempotencyLockInput,
): Promise<IdempotencyKeyRow | null> {
  const rows = await db
    .insert(idempotencyKeys)
    .values({
      key: input.key,
      specialistId: input.specialistId,
      endpoint: input.endpoint,
      requestHash: input.requestHash,
      status: "IN_FLIGHT",
      traceId: input.traceId,
    })
    .onConflictDoNothing({ target: idempotencyKeys.key })
    .returning();
  return rows[0] ?? null;
}

export async function getIdempotencyKey(
  db: DbOrTx,
  key: string,
): Promise<IdempotencyKeyRow | null> {
  const rows = await db
    .select()
    .from(idempotencyKeys)
    .where(eq(idempotencyKeys.key, key))
    .limit(1);
  return rows[0] ?? null;
}

export async function markIdempotencyCompleted(
  db: DbOrTx,
  key: string,
  responseStatusCode: number,
  responseBody: unknown,
): Promise<void> {
  await db
    .update(idempotencyKeys)
    .set({
      status: "COMPLETED",
      responseStatusCode,
      responseBody,
      completedAt: sql`NOW()`,
    })
    .where(eq(idempotencyKeys.key, key));
}

export async function markIdempotencyFailedTerminal(
  db: DbOrTx,
  key: string,
  responseStatusCode: number,
  responseBody: unknown,
): Promise<void> {
  await db
    .update(idempotencyKeys)
    .set({
      status: "FAILED_TERMINAL",
      responseStatusCode,
      responseBody,
      completedAt: sql`NOW()`,
    })
    .where(eq(idempotencyKeys.key, key));
}

// Releases a held lock (5xx / network failure → safe to retry) and also evicts
// a stale expired row the cleanup cron has not yet swept. Both callers want the
// same effect: the row is gone, the key is free.
export async function deleteIdempotencyKey(db: DbOrTx, key: string): Promise<void> {
  await db.delete(idempotencyKeys).where(eq(idempotencyKeys.key, key));
}

// Daily TTL sweep (TR-WRITE-2c). In Production Mode, Redis `EXPIREAT` evicts
// keys server-side and this cron is not needed. Returns the deleted row count.
export async function cleanupExpiredIdempotencyKeys(db: DbOrTx): Promise<number> {
  const deleted = await db
    .delete(idempotencyKeys)
    .where(lt(idempotencyKeys.expiresAt, sql`NOW()`))
    .returning({ key: idempotencyKeys.key });
  return deleted.length;
}
