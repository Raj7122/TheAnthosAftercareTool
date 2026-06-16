// cdc_health repository — the CDC worker's heartbeat + cursor state (P1C-03,
// ERD §6.9). The Demo-Mode REST-polling worker reads `subscription_states`
// (a per-SObject ISO-8601 SystemModstamp cursor map) at cycle start, polls
// Salesforce, and on the way out UPSERTs the row with the new cursors plus
// `last_heartbeat_at = NOW()`. P1C-04 reads `subscription_status` +
// `last_heartbeat_at` through `readStaleness()` to render "data may be stale".
//
// Substrate seam (`[[feedback_substrate_shape_invariant]]`): in Production
// SAD §12.2 / ADR-06 replaces the worker with a long-lived gRPC Pub/Sub
// subscriber that writes the SAME columns — `replay_id` carries the Pub/Sub
// replay id; `subscription_states` carries per-channel replay state. The
// repository contract below survives that swap unchanged.
//
// No audit row on writes: the cycle log line is the operational record;
// audit-log writes are reserved for state mutations on participant data
// (Immutable #5), and this worker is read-only against Salesforce.
//
// Status transitions are intentionally bounded by the worker, not the
// repository: the caller passes the `subscription_status` it computed from
// its consecutive-failure counter and a max-failure threshold. Keeping the
// derivation in the worker keeps this layer substrate-neutral — the gRPC
// subscriber's failure signal is a connection drop, not an HTTP error count.

import { sql } from "drizzle-orm";

import type { DbOrTx } from "../db/types.js";
import type { SubscriptionStatus } from "../schema/cdc_health.js";
import { cdcHealth } from "../schema/index.js";

// `STOPPED` is reserved for a graceful worker shutdown; the REST poller does
// not set it from a cycle path.
export type CycleSubscriptionStatus = Exclude<SubscriptionStatus, "STOPPED">;

// Per-SObject ISO-8601 SystemModstamp cursor map. Keys are Salesforce API
// names (e.g., `Case_Note__c`); values are ISO-8601 timestamps from the
// most-recently observed SystemModstamp for that object.
export type CursorMap = Record<string, string>;

// Salesforce Pub/Sub event retention is 72h per ERD §6.9 v1.2. If the worker
// has been disconnected longer, replay-by-cursor is no longer safe and the
// system MUST fall back to a full bulk cache refresh.
export type RecoveryMode =
  | "first_run_full_hydrate"
  | "replay_window_expired_full_hydrate"
  | "safe_to_replay";

const REPLAY_WINDOW_HOURS = 72;

// Reads the row matching `workerId`. Returns `null` when no heartbeat has been
// recorded yet — the caller treats this as `first_run_full_hydrate`.
export interface CdcHealthRow {
  id: string;
  workerId: string;
  lastHeartbeatAt: Date;
  lastEventId: string | null;
  lastEventReceivedAt: Date | null;
  subscriptionStatus: SubscriptionStatus;
  subscriptionStates: CursorMap;
  errorCount24h: number;
  replayId: string | null;
  updatedAt: Date;
}

async function readRow(
  db: DbOrTx,
  workerId: string,
): Promise<CdcHealthRow | null> {
  const rows = await db
    .select()
    .from(cdcHealth)
    .where(sql`${cdcHealth.workerId} = ${workerId}`)
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    return null;
  }
  return {
    id: row.id,
    workerId: row.workerId,
    lastHeartbeatAt: row.lastHeartbeatAt,
    lastEventId: row.lastEventId,
    lastEventReceivedAt: row.lastEventReceivedAt,
    subscriptionStatus: row.subscriptionStatus as SubscriptionStatus,
    subscriptionStates: (row.subscriptionStates ?? {}) as CursorMap,
    errorCount24h: row.errorCount24h,
    replayId: row.replayId,
    updatedAt: row.updatedAt,
  };
}

// Returns the per-SObject cursor map. Empty when the worker has never run.
// Callers use this to seed `SystemModstamp > :cursor` SOQL filters.
export async function readCursors(
  db: DbOrTx,
  workerId: string,
): Promise<CursorMap> {
  const row = await readRow(db, workerId);
  return row?.subscriptionStates ?? {};
}

// Public-facing staleness contract for P1C-04. Read-only; the SPA never writes
// here. `lastEventReceivedAt` is null when no CDC event has ever landed.
export interface StalenessSummary {
  status: SubscriptionStatus;
  lastHeartbeatAt: Date | null;
  lastEventReceivedAt: Date | null;
}

export async function readStaleness(
  db: DbOrTx,
  workerId: string,
): Promise<StalenessSummary> {
  const row = await readRow(db, workerId);
  if (row === null) {
    // No heartbeat yet — treat as DISCONNECTED so the UI shows the "may be
    // stale" affordance until the worker writes its first cycle.
    return {
      status: "DISCONNECTED",
      lastHeartbeatAt: null,
      lastEventReceivedAt: null,
    };
  }
  return {
    status: row.subscriptionStatus,
    lastHeartbeatAt: row.lastHeartbeatAt,
    lastEventReceivedAt: row.lastEventReceivedAt,
  };
}

export interface RecordCycleInput {
  workerId: string;
  // Full new cursor map (the worker merged any prior cursors with cycle
  // advances). Stored verbatim; callers preserve unchanged-object keys.
  cursors: CursorMap;
  // The Salesforce id + modstamp of the most recent event observed this
  // cycle, formatted as `"<object>:<modstamp>"`. Null when zero events.
  lastEventId: string | null;
  lastEventReceivedAt: Date | null;
  subscriptionStatus: CycleSubscriptionStatus;
  // True when the cycle errored. Increments `error_count_24h`; the daily
  // cleanup cron is responsible for decay (out of scope for this ticket).
  cycleErrored: boolean;
}

// Idempotent UPSERT on `worker_id`. Advances `last_heartbeat_at` and
// `updated_at` to NOW(); merges the new cursor map into `subscription_states`;
// conditionally updates `last_event_id` / `last_event_received_at` only when
// the cycle observed an event (so a zero-event cycle does not blank a real
// prior event); recomputes `subscription_status`; bumps `error_count_24h` on
// error.
//
// The UPSERT target needs a UNIQUE/PK constraint. The schema's PK is `id`
// (uuid), generated server-side; the ERD does not put a unique index on
// `worker_id`, so single-statement INSERT … ON CONFLICT (worker_id) is not
// available. The read-then-insert/update pair is wrapped in `db.transaction`
// to make the sequence atomic — without the transaction, two overlapping
// invocations (e.g., Vercel re-running a timed-out handler while the prior
// is still alive) could both observe `existing === null` and race the
// INSERT (PK collision) or read the same `existing.id` and silently lose
// the later UPDATE's cursor advance. The transaction is short (no
// Salesforce I/O inside it) so contention is bounded by the cron cadence.
export async function recordCycle(
  db: DbOrTx,
  input: RecordCycleInput,
): Promise<void> {
  await db.transaction(async (tx) => {
    const existing = await readRow(tx, input.workerId);
    if (existing === null) {
      await tx.insert(cdcHealth).values({
        workerId: input.workerId,
        lastHeartbeatAt: sql`NOW()`,
        lastEventId: input.lastEventId,
        lastEventReceivedAt: input.lastEventReceivedAt,
        subscriptionStatus: input.subscriptionStatus,
        subscriptionStates: input.cursors,
        errorCount24h: input.cycleErrored ? 1 : 0,
        updatedAt: sql`NOW()`,
      });
      return;
    }

    // Preserve prior `last_event_*` when the cycle was empty. Drizzle's `set`
    // accepts undefined to skip the field — keep them out of the patch.
    const patch: Record<string, unknown> = {
      lastHeartbeatAt: sql`NOW()`,
      subscriptionStatus: input.subscriptionStatus,
      subscriptionStates: input.cursors,
      errorCount24h: input.cycleErrored
        ? sql`${cdcHealth.errorCount24h} + 1`
        : cdcHealth.errorCount24h,
      updatedAt: sql`NOW()`,
    };
    if (input.lastEventId !== null) {
      patch["lastEventId"] = input.lastEventId;
    }
    if (input.lastEventReceivedAt !== null) {
      patch["lastEventReceivedAt"] = input.lastEventReceivedAt;
    }
    await tx
      .update(cdcHealth)
      .set(patch)
      .where(sql`${cdcHealth.id} = ${existing.id}`);
  });
}

// Evaluates the recovery mode the worker should enter on startup. Mirrors the
// ERD §6.9 v1.2 contract verbatim. The worker calls this once per process,
// before its first cycle.
export async function evaluateRecoveryMode(
  db: DbOrTx,
  workerId: string,
): Promise<RecoveryMode> {
  const row = await readRow(db, workerId);
  if (row === null || row.lastEventReceivedAt === null) {
    return "first_run_full_hydrate";
  }
  const cutoff = Date.now() - REPLAY_WINDOW_HOURS * 60 * 60 * 1000;
  if (row.lastEventReceivedAt.getTime() < cutoff) {
    return "replay_window_expired_full_hydrate";
  }
  return "safe_to_replay";
}
