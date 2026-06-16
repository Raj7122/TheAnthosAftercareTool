// Demo-Mode IdempotencyStore — Postgres `idempotency_keys` table via the
// @anthos/persistence repository. This module is loaded only through a dynamic
// import (middleware default-store resolution and the cleanup cron), so the
// connection side effect in @anthos/persistence never enters the static import
// graph of @anthos/api — unit tests that inject a fake store stay DB-free.

import { db as defaultDb, repositories } from "@anthos/persistence";
import type { DbClient } from "@anthos/persistence";

import type { IdempotencyRecord, IdempotencyStatus, IdempotencyStore } from "./store.js";

type IdempotencyKeyRow = NonNullable<
  Awaited<ReturnType<typeof repositories.acquireIdempotencyLock>>
>;

function toRecord(row: IdempotencyKeyRow): IdempotencyRecord {
  return {
    key: row.key,
    specialistId: row.specialistId,
    status: row.status as IdempotencyStatus,
    requestHash: row.requestHash,
    responseStatusCode: row.responseStatusCode,
    responseBody: row.responseBody,
    traceId: row.traceId,
    expiresAt: row.expiresAt,
  };
}

export function createPostgresIdempotencyStore(database: DbClient): IdempotencyStore {
  return {
    async acquire(input) {
      const row = await repositories.acquireIdempotencyLock(database, input);
      return row === null ? null : toRecord(row);
    },
    async get(key) {
      const row = await repositories.getIdempotencyKey(database, key);
      return row === null ? null : toRecord(row);
    },
    async markCompleted(key, responseStatusCode, responseBody) {
      await repositories.markIdempotencyCompleted(
        database,
        key,
        responseStatusCode,
        responseBody,
      );
    },
    async markFailedTerminal(key, responseStatusCode, responseBody) {
      await repositories.markIdempotencyFailedTerminal(
        database,
        key,
        responseStatusCode,
        responseBody,
      );
    },
    async delete(key) {
      await repositories.deleteIdempotencyKey(database, key);
    },
    async cleanupExpired() {
      return repositories.cleanupExpiredIdempotencyKeys(database);
    },
  };
}

export function createDefaultPostgresStore(): IdempotencyStore {
  return createPostgresIdempotencyStore(defaultDb);
}
