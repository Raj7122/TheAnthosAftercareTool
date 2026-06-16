// Daily TTL cleanup entry point for the `idempotency_keys` table (TR-WRITE-2c).
// Invoked by the Vercel cron route. The Postgres store is loaded via a dynamic
// import so the DB connection side effect stays out of the static import graph
// of @anthos/api.
//
// Production Mode: Redis `EXPIREAT` evicts keys server-side and this cron is
// not deployed (Pattern D — Demo vs Production).

export async function runIdempotencyCleanup(): Promise<{ deleted: number }> {
  const { createDefaultPostgresStore } = await import("./postgres-store.js");
  const store = createDefaultPostgresStore();
  const deleted = await store.cleanupExpired();
  return { deleted };
}
