// offline_queue repository — the BFF's read surface over the server-side
// mirror of the client Outbox (P3C-04, ERD §6.3). Rows accumulate only when
// the Review Required state machine (TR-OFFLINE-5a) trips or the retry budget
// exhausts (TR-OFFLINE-7a); a clean 2xx flush leaves no row.
//
// P3C-05 is the first reader: `GET /api/v1/queue/pending` (API §7.5.1, E-17).
// The endpoint returns the caller's non-terminal items plus per-status counts
// so the SPA can render the F-14 queue indicator (P3C-12) and the Review
// Required surface (P3C-07).
//
// "Non-terminal" matches the partial index `idx_offline_queue_status`
// (offline_queue.ts:73) — `completed` and `discarded` are filtered out. The
// per-specialist filter uses `idx_offline_queue_specialist`
// (specialist_id, status, created_at DESC).
//
// Substrate seam: queue lifecycle is BFF-driven, not substrate-specific —
// the column set survives the AWS RDS swap unchanged
// ([[feedback_substrate_shape_invariant]]).
//
// No audit row on reads: Immutable #5 governs state mutations, not reads.

import { and, desc, eq, inArray, notInArray, sql } from "drizzle-orm";

import type { DbOrTx } from "../db/types.js";
import { offlineQueue } from "../schema/index.js";
import type {
  OfflineQueueStatus,
  ResolutionAction,
  ResolutionSource,
} from "../schema/index.js";

// TR-OFFLINE-7 — the per-specialist queue is bounded at ≤100 items. Enforced
// here at the query layer so the handler cannot accidentally exceed it.
export const QUEUE_PENDING_MAX_ITEMS = 100;

// Terminal states (excluded from "pending"). Reads as a tuple of the schema's
// `OfflineQueueStatus` union; widening it would also widen the partial-index
// predicate, so they stay in lockstep.
const TERMINAL_STATUSES: ReadonlyArray<OfflineQueueStatus> = [
  "completed",
  "discarded",
];

// The five non-terminal statuses surface in the §7.5.1 `counts` object. Listed
// explicitly so the response always carries every key (zero when none present).
export const NON_TERMINAL_STATUSES = [
  "pending_sync",
  "in_flight",
  "review_required_reassigned",
  "review_required_terminated",
  "failed_max_retries",
] as const satisfies ReadonlyArray<OfflineQueueStatus>;

export type NonTerminalStatus = (typeof NON_TERMINAL_STATUSES)[number];

// One row of the wire response, projected from `offline_queue`. The raw
// `payload` jsonb is returned here so the handler can route it through the
// `derivePayloadPreview` redactor — a repository result must not echo the full
// payload to the wire (Immutable #1).
export interface OfflineQueueRow {
  id: string;
  specialistId: string;
  participantId: string | null;
  actionType: string;
  status: OfflineQueueStatus;
  createdAt: Date;
  lastAttemptAt: Date | null;
  retryCount: number;
  errorDetails: unknown;
  payload: unknown;
}

export type StatusCounts = Record<NonTerminalStatus, number>;

export interface PendingQueueResult {
  rows: ReadonlyArray<OfflineQueueRow>;
  counts: StatusCounts;
  queueDepth: number;
}

// Returns the caller's pending queue items and per-status counts. Two queries
// (rows + GROUP BY counts) so `queueDepth` reflects the full non-terminal
// count even when more than `QUEUE_PENDING_MAX_ITEMS` rows exist — the SPA's
// indicator (P3C-12) needs the true depth, not just the truncated page.
//
// Pure read — no audit row. Per-specialist scoping is the query predicate;
// callers MUST resolve `specialistId` from the session (never a query param).
export async function getPendingForSpecialist(
  db: DbOrTx,
  specialistId: string,
): Promise<PendingQueueResult> {
  const baseWhere = and(
    eq(offlineQueue.specialistId, specialistId),
    notInArray(offlineQueue.status, TERMINAL_STATUSES as OfflineQueueStatus[]),
  );

  const rawRows = await db
    .select({
      id: offlineQueue.id,
      specialistId: offlineQueue.specialistId,
      participantId: offlineQueue.participantId,
      actionType: offlineQueue.actionType,
      status: offlineQueue.status,
      createdAt: offlineQueue.createdAt,
      lastAttemptAt: offlineQueue.lastAttemptAt,
      retryCount: offlineQueue.retryCount,
      errorDetails: offlineQueue.errorDetails,
      payload: offlineQueue.payload,
    })
    .from(offlineQueue)
    .where(baseWhere)
    .orderBy(desc(offlineQueue.createdAt))
    .limit(QUEUE_PENDING_MAX_ITEMS);

  const countRows = await db
    .select({
      status: offlineQueue.status,
      n: sql<number>`COUNT(*)::int`,
    })
    .from(offlineQueue)
    .where(baseWhere)
    .groupBy(offlineQueue.status);

  const counts = emptyCounts();
  let queueDepth = 0;
  for (const row of countRows) {
    if (isNonTerminal(row.status)) {
      counts[row.status] = row.n;
      queueDepth += row.n;
    }
  }

  const rows: OfflineQueueRow[] = rawRows.map((row) => ({
    id: row.id,
    specialistId: row.specialistId,
    participantId: row.participantId,
    actionType: row.actionType,
    status: row.status as OfflineQueueStatus,
    createdAt: row.createdAt,
    lastAttemptAt: row.lastAttemptAt,
    retryCount: row.retryCount,
    errorDetails: row.errorDetails,
    payload: row.payload,
  }));

  return { rows, counts, queueDepth };
}

// Single-row lookup by `offline_queue.id` (PK). Used by P3C-07's
// `POST /api/v1/queue/:id/resolve` (E-19) to read the queue item before
// applying the specialist's resolution. Returns `null` when the id is unknown
// so the handler can convert a missing row + a cross-specialist mismatch into
// the same 404 response — the BFF must not reveal the existence of another
// specialist's queue rows (PII firewall posture; mirrors get-queue-pending's
// "server-resolved scope, never query param").
export async function findQueueItemById(
  db: DbOrTx,
  id: string,
): Promise<OfflineQueueRow | null> {
  const rows = await db
    .select({
      id: offlineQueue.id,
      specialistId: offlineQueue.specialistId,
      participantId: offlineQueue.participantId,
      actionType: offlineQueue.actionType,
      status: offlineQueue.status,
      createdAt: offlineQueue.createdAt,
      lastAttemptAt: offlineQueue.lastAttemptAt,
      retryCount: offlineQueue.retryCount,
      errorDetails: offlineQueue.errorDetails,
      payload: offlineQueue.payload,
    })
    .from(offlineQueue)
    .where(eq(offlineQueue.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    specialistId: row.specialistId,
    participantId: row.participantId,
    actionType: row.actionType,
    status: row.status as OfflineQueueStatus,
    createdAt: row.createdAt,
    lastAttemptAt: row.lastAttemptAt,
    retryCount: row.retryCount,
    errorDetails: row.errorDetails,
    payload: row.payload,
  };
}

// Resolution-write column set per ERD §6.3 + Pattern E line 36–50. The handler
// computes the new column values (status / retry_count / payload / resolution_*
// fields) and this repo function commits them in a single UPDATE — keeping the
// SQL surface scope-narrow so future state-machine work (P3C-08) can layer its
// transition guards on top without touching the persistence boundary.
export interface ApplyQueueResolutionInput {
  readonly id: string;
  readonly status: OfflineQueueStatus;
  readonly resolutionAction: ResolutionAction;
  readonly resolutionSource: ResolutionSource;
  readonly resolvedAt: Date;
  readonly resolvedBy: string;
  readonly resolutionNotes: string | null;
  // Set only for REASSIGN_RETRY: reset retry budget to 0 (Pattern E line 42)
  // and rewrite payload to carry the new owner so the next flush targets the
  // correct specialist.
  readonly retryCount?: number;
  readonly payload?: unknown;
}

// The two source states a resolution may transition FROM (Pattern E line
// 30/31). Constraining the UPDATE to these statuses makes the write an
// atomic optimistic lock: a concurrent second resolution that beats us to
// the row will find the status already transitioned away (e.g. to
// `discarded`) and the UPDATE will match zero rows. The handler converts
// `0` to a 409, preserving the Review Required state-machine invariant
// that one resolution wins and the other surfaces an explicit conflict.
const RESOLVABLE_STATUSES_FOR_WRITE: ReadonlyArray<OfflineQueueStatus> = [
  "review_required_reassigned",
  "review_required_terminated",
];

// Returns the number of rows updated. The handler treats `0` as a
// concurrent-resolve race (another writer transitioned the row before
// us) and surfaces a 409.
export async function applyQueueResolution(
  db: DbOrTx,
  input: ApplyQueueResolutionInput,
): Promise<number> {
  const update: Record<string, unknown> = {
    status: input.status,
    resolutionAction: input.resolutionAction,
    resolutionSource: input.resolutionSource,
    resolvedAt: input.resolvedAt,
    resolvedBy: input.resolvedBy,
    resolutionNotes: input.resolutionNotes,
  };
  if (input.retryCount !== undefined) update.retryCount = input.retryCount;
  if (input.payload !== undefined) update.payload = input.payload;
  const result = await db
    .update(offlineQueue)
    .set(update)
    .where(
      and(
        eq(offlineQueue.id, input.id),
        inArray(
          offlineQueue.status,
          RESOLVABLE_STATUSES_FOR_WRITE as OfflineQueueStatus[],
        ),
      ),
    )
    .returning({ id: offlineQueue.id });
  return result.length;
}

function emptyCounts(): StatusCounts {
  return {
    pending_sync: 0,
    in_flight: 0,
    review_required_reassigned: 0,
    review_required_terminated: 0,
    failed_max_retries: 0,
  };
}

function isNonTerminal(value: string): value is NonTerminalStatus {
  return (NON_TERMINAL_STATUSES as ReadonlyArray<string>).includes(value);
}
