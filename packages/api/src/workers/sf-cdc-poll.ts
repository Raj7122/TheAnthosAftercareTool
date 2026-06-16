// P1C-03: Salesforce CDC polling worker. Demo-Mode REST-polling fallback per
// implementation plan §1.5 slaughter list item 17 (gRPC Pub/Sub deferred to
// Production). The worker:
//
//   1. Reads per-SObject ISO-8601 cursors from `cdc_health.subscription_states`
//   2. SOQL-polls each canonical object for `SystemModstamp > :cursor`
//      (`packages/integrations/.../cdc-poll.ts`)
//   3. Dedupes the unique OwnerIds across the cycle
//   4. Dispatches `invalidateCaseloadCache({kind:'specialist', specialistId})`
//      for each unique owner — the {specialist,queue}-pair contract is on
//      P1C-02 but specialist scope avoids importing M-CONFIG predicates into
//      the worker
//   5. UPSERTs `cdc_health` with the advanced cursors + heartbeat + status
//      AFTER invalidations are dispatched. Persist-before-consume is
//      enforced by this *ordering* (invalidate first, then advance the
//      cursor) — NOT by a shared transaction. A crash between the two
//      writes re-polls the same window on the next cycle, which is the
//      event-loss-safe failure mode: cache invalidations are idempotent
//      (`DELETE … WHERE specialist_id = …` is a no-op on the second run)
//      and a redundant invalidate just forces a cold rehydrate. If a
//      future change reorders these two writes, the event-loss guarantee
//      breaks.
//   6. Emits ONE structured log line per cycle — counts and IDs only, no PII
//
// Two entry points are exported:
//
//   • `runPollCycle(deps)` — one cycle. Pure of process state; all deps
//     (db, sfClient, logger, now) are injected so unit tests can run with
//     mocks and the Production gRPC subscriber can reuse it.
//
//   • `runPollInvocation(opts?)` — orchestrates the Vercel cron handler:
//     resolves real deps via dynamic import (keeps DB connection side
//     effects out of the static graph of @anthos/api), generates a trace_id,
//     evaluates recovery mode on the first call, and runs the dual-pass
//     (cycle → sleep 30s → cycle) that yields a 30s effective cadence under
//     a 1-minute Vercel cron schedule.

import type { StructuredLogger } from "@anthos/logging";
import type {
  CursorMap,
  CycleSubscriptionStatus,
  InvalidateScope,
  RecordCycleInput,
  RecoveryMode,
} from "@anthos/persistence";
import type { DbClient } from "@anthos/persistence";
import type { SalesforceRestClient } from "@anthos/integrations";

// The persistence surface the cycle actually uses. Extracted so unit tests
// can substitute an in-memory fake without booting Postgres — the round-trip
// against the real DB is covered by `sf-cdc-poll.integration.test.ts`.
export interface CdcWorkerPersistence {
  readCursors(db: DbClient, workerId: string): Promise<CursorMap>;
  invalidateCaseloadCache(db: DbClient, scope: InvalidateScope): Promise<number>;
  recordCycle(db: DbClient, input: RecordCycleInput): Promise<void>;
}

// TRD INT-SF-3 v1.8: Case Note, Barriers, Incident, plus Program Enrollment
// ownership-change polling. Object Stability Visit (folded into Case Note) and
// Activity (handled via Salesforce Flow, not CDC) were removed in v1.8.
// [TBD-v1.8-1] — IDW prefix provenance is unresolved; the bulk-hydration
// adapter uses `IDW_Program_Enrollment__c` and dropped its `IDW_Case_Note__c`
// query. The canonical list is overridable to keep the worker aligned with
// whichever set Erick confirms (Data Dictionary Part 5). Mogli SMS Log is
// `[TBD-v1.8-3]` and intentionally absent from the Demo defaults.
export const DEFAULT_POLLED_OBJECTS: ReadonlyArray<string> = [
  "IDW_Case_Note__c",
  "Barriers__c",
  "Incident__c",
  "IDW_Program_Enrollment__c",
];

export const DEFAULT_WORKER_ID = "sf-cdc-poll";

// MON-ALERT-11 contract: status transitions on consecutive cycle failures.
// `CONNECTED` → `RECONNECTING` on first failure; `RECONNECTING` →
// `DISCONNECTED` after `MAX_CONSECUTIVE_FAILURES_DISCONNECTED` cumulative
// failures within the process. The thresholds are intentionally generous —
// the alert layer (Production) is the load-bearer for paging.
const MAX_CONSECUTIVE_FAILURES_DISCONNECTED = 3;

// Dual-pass cadence: one cron tick = two poll cycles 30s apart, yielding a
// 30s effective polling cadence on a 1-minute Vercel cron schedule. This is
// the substrate-fit choice noted in the plan; Production swaps `setInterval`
// onto the same `runPollCycle()` and the value here becomes the loop period.
export const DUAL_PASS_INTERCYCLE_MS = 30_000;

// Cycle-level per-poll error tracker. The worker treats one SF error as a
// soft cycle failure (logs a warn, increments error count, continues to the
// next object); the cycle's overall status is the worst per-object outcome.
interface CycleErrorRecord {
  readonly object: string;
  readonly code: string;
  readonly status?: number;
}

export interface PollCycleResult {
  readonly traceId: string;
  readonly durationMs: number;
  readonly eventsTotal: number;
  readonly eventsByObject: Record<string, number>;
  readonly invalidations: number;
  readonly status: CycleSubscriptionStatus;
  readonly errors: ReadonlyArray<CycleErrorRecord>;
  readonly partial: boolean;
}

export interface RunPollCycleDeps {
  readonly db: DbClient;
  readonly sfClient: SalesforceRestClient;
  readonly logger: StructuredLogger;
  readonly workerId?: string;
  readonly objects?: ReadonlyArray<string>;
  // Optional injection point for the persistence surface. Defaults to the
  // real repositories loaded via dynamic import (keeps the DB connection
  // side effect out of the static graph of @anthos/api). Tests substitute
  // an in-memory fake so they can assert OwnerId-fan-out behavior without
  // Postgres.
  readonly persistence?: CdcWorkerPersistence;
  // Injected so tests can advance time deterministically.
  readonly now?: () => Date;
  // Bumped from prior cycles within the same process so a transient blip
  // escalates `RECONNECTING` → `DISCONNECTED` after enough consecutive misses.
  readonly priorConsecutiveFailures?: number;
}

interface ObjectPollOutcome {
  readonly object: string;
  readonly ownerIds: ReadonlySet<string>;
  readonly nextCursorIso: string | null;
  readonly eventCount: number;
  readonly partial: boolean;
  readonly error: CycleErrorRecord | null;
  readonly lastEventId: string | null;
  readonly lastEventReceivedAt: Date | null;
}

// One CDC poll cycle. Reads cursors, polls each canonical object, deduplicates
// OwnerIds, dispatches cache invalidations, persists the new cursor map +
// heartbeat, and emits one log line. Dependencies are injected so callers can
// substitute mocks (unit tests) or the Production gRPC subscriber's event
// source. Trace_id is generated here so the log line, the per-object error
// records, and any downstream observability share the same correlation id.
export async function runPollCycle(
  deps: RunPollCycleDeps,
): Promise<PollCycleResult> {
  const { pollObjectChanges } = await import("@anthos/integrations");
  const persistence = deps.persistence ?? (await import("@anthos/persistence")).repositories;

  const now = deps.now ?? (() => new Date());
  const workerId = deps.workerId ?? DEFAULT_WORKER_ID;
  const objects = deps.objects ?? DEFAULT_POLLED_OBJECTS;
  const traceId = generateTraceId();
  const cycleStartedAt = now();
  const cycleLogger = deps.logger.child({ traceId });

  const priorCursors = await persistence.readCursors(deps.db, workerId);
  const nextCursors: CursorMap = { ...priorCursors };

  const outcomes: ObjectPollOutcome[] = [];
  for (const object of objects) {
    const since = priorCursors[object] ?? null;
    let outcome: ObjectPollOutcome;
    try {
      const result = await pollObjectChanges(deps.sfClient, {
        object,
        sinceIso: since,
      });
      const ownerIds = new Set<string>();
      let lastEventReceivedAt: Date | null = null;
      let lastEventId: string | null = null;
      for (const record of result.records) {
        if (record.OwnerId !== null && record.OwnerId.length > 0) {
          ownerIds.add(record.OwnerId);
        }
        lastEventReceivedAt = parseSystemModstamp(record.SystemModstamp);
        lastEventId = `${object}:${record.Id}`;
      }
      outcome = {
        object,
        ownerIds,
        nextCursorIso: result.nextCursorIso,
        eventCount: result.records.length,
        partial: result.partial,
        error: null,
        lastEventId,
        lastEventReceivedAt,
      };
    } catch (err) {
      const code = errorCode(err);
      cycleLogger.warn("sf-cdc-poll object failed", {
        event: "sf_cdc_poll.object_failed",
        object,
        error_code: code,
      });
      outcome = {
        object,
        ownerIds: new Set<string>(),
        // Do NOT advance the cursor on error — next cycle re-polls the same
        // window so events are not silently dropped on a transient blip.
        nextCursorIso: since,
        eventCount: 0,
        partial: false,
        error: {
          object,
          code,
          ...(errorStatus(err) !== null ? { status: errorStatus(err) as number } : {}),
        },
        lastEventId: null,
        lastEventReceivedAt: null,
      };
    }
    if (outcome.nextCursorIso !== null) {
      nextCursors[object] = outcome.nextCursorIso;
    }
    outcomes.push(outcome);
  }

  // Dedupe OwnerIds across all objects — many CDC events for one specialist
  // collapse to one invalidate call. The cache contract supports a precise
  // `{specialist, queue}` scope but specialist-only is within the contract
  // and avoids importing M-CONFIG predicates into the worker.
  const allOwnerIds = new Set<string>();
  for (const o of outcomes) {
    for (const id of o.ownerIds) {
      allOwnerIds.add(id);
    }
  }
  let invalidations = 0;
  for (const specialistId of allOwnerIds) {
    invalidations += await persistence.invalidateCaseloadCache(deps.db, {
      kind: "specialist",
      specialistId,
    });
  }

  const eventsTotal = outcomes.reduce((sum, o) => sum + o.eventCount, 0);
  const eventsByObject: Record<string, number> = {};
  for (const o of outcomes) {
    eventsByObject[o.object] = o.eventCount;
  }
  const partial = outcomes.some((o) => o.partial);
  const errors: CycleErrorRecord[] = outcomes
    .map((o) => o.error)
    .filter((e): e is CycleErrorRecord => e !== null);
  const cycleErrored = errors.length > 0;
  const status = computeCycleStatus({
    partial,
    cycleErrored,
    priorConsecutiveFailures: deps.priorConsecutiveFailures ?? 0,
  });

  // Pick the most recent event observed across the cycle as the row's
  // `last_event_*` advance. The repository preserves prior `last_event_*`
  // when both fields are null (zero-event cycle).
  const lastEventOutcome = outcomes
    .filter((o) => o.lastEventReceivedAt !== null)
    .sort(
      (a, b) =>
        (b.lastEventReceivedAt as Date).getTime() -
        (a.lastEventReceivedAt as Date).getTime(),
    )[0];

  await persistence.recordCycle(deps.db, {
    workerId,
    cursors: nextCursors,
    lastEventId: lastEventOutcome?.lastEventId ?? null,
    lastEventReceivedAt: lastEventOutcome?.lastEventReceivedAt ?? null,
    subscriptionStatus: status,
    cycleErrored,
  });

  const durationMs = now().getTime() - cycleStartedAt.getTime();
  // PII firewall: no participant fields. Only IDs (which are not PII per
  // the SoR rule — "SF record IDs are not PII") and counts.
  cycleLogger.info("sf-cdc-poll cycle complete", {
    event: "sf_cdc_poll.cycle",
    worker: workerId,
    duration_ms: durationMs,
    events_total: eventsTotal,
    events_by_object: eventsByObject,
    invalidations,
    status,
    partial,
    errors,
  });

  return {
    traceId,
    durationMs,
    eventsTotal,
    eventsByObject,
    invalidations,
    status,
    errors,
    partial,
  };
}

export interface RunPollInvocationOptions {
  // Override for testing or local-only runs. In Vercel the defaults wire
  // up the real DB + Connected App auth.
  readonly db?: DbClient;
  readonly sfClient?: SalesforceRestClient;
  readonly logger?: StructuredLogger;
  // Sleep between cycles. Defaults to a real setTimeout; tests inject a stub.
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface PollInvocationResult {
  readonly recoveryMode: RecoveryMode;
  readonly cycles: ReadonlyArray<PollCycleResult>;
}

// Vercel cron handler entry point. Builds real deps via dynamic import (so
// the DB connection side effect stays out of @anthos/api's static graph),
// evaluates startup recovery mode once, and runs the dual-pass that yields a
// 30s effective polling cadence under a 1-minute Vercel cron schedule.
//
// `cycles` carries both runs so the route can surface aggregate counts and
// the test harness can assert on each cycle independently.
export async function runPollInvocation(
  options: RunPollInvocationOptions = {},
): Promise<PollInvocationResult> {
  const logger =
    options.logger ??
    (await import("@anthos/logging")).createLogger({
      module: "api.workers.sf_cdc_poll",
    });

  const db = options.db ?? (await import("@anthos/persistence")).db;
  const sfClient =
    options.sfClient ?? (await buildDefaultSalesforceClient());

  const { repositories } = await import("@anthos/persistence");
  const recoveryMode = await repositories.evaluateRecoveryMode(
    db,
    DEFAULT_WORKER_ID,
  );
  if (recoveryMode !== "safe_to_replay") {
    // The full-hydrate path is out of scope for P1C-03 — P1C-04 / a future
    // ticket owns the bulk-refresh response. We log the recovery mode so the
    // operator can act, then continue with cursor-based polling. The next
    // cycle's cursor reset / hydrate is left to that follow-up ticket.
    logger.warn("sf-cdc-poll recovery mode requires full hydrate", {
      event: "sf_cdc_poll.recovery_mode",
      recovery_mode: recoveryMode,
    });
  }

  const sleep =
    options.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }));

  // Pass 1.
  const first = await runPollCycle({ db, sfClient, logger });
  const firstFailureCount = first.status === "CONNECTED" ? 0 : 1;
  // Wait 30s. The handler must run before the function execution timeout
  // (`maxDuration` on the route) elapses — the route sets it to 60.
  await sleep(DUAL_PASS_INTERCYCLE_MS);
  // Pass 2 — escalates status if the first cycle also failed.
  const second = await runPollCycle({
    db,
    sfClient,
    logger,
    priorConsecutiveFailures: firstFailureCount,
  });

  return { recoveryMode, cycles: [first, second] };
}

// Build the default REST client backed by the Connected App refresh-token
// flow. Mirrors `selectSalesforceAuth()` but always picks the connected-app
// branch — the worker has no specialist session to fall back on.
async function buildDefaultSalesforceClient(): Promise<SalesforceRestClient> {
  const { SalesforceConnectedAppAuth, SalesforceRestClient: Client } =
    await import("@anthos/integrations");
  return new Client({ auth: new SalesforceConnectedAppAuth() });
}

function computeCycleStatus(input: {
  partial: boolean;
  cycleErrored: boolean;
  priorConsecutiveFailures: number;
}): CycleSubscriptionStatus {
  if (input.cycleErrored) {
    const cumulative = input.priorConsecutiveFailures + 1;
    if (cumulative >= MAX_CONSECUTIVE_FAILURES_DISCONNECTED) {
      return "DISCONNECTED";
    }
    return "RECONNECTING";
  }
  if (input.partial) {
    return "PARTIAL";
  }
  return "CONNECTED";
}

function parseSystemModstamp(iso: string): Date {
  return new Date(iso);
}

function generateTraceId(): string {
  // Re-use the @anthos/logging UUIDv4 helper. We import it lazily to keep
  // the static import surface small in test runs that pre-stub the worker.
  // The helper is only consulted once per cycle.
  // Using node:crypto directly here avoids a circular dependency with the
  // logger module's resolveTraceId/forwardWithTraceId (which take a Request).
  return (globalThis.crypto?.randomUUID?.() as string | undefined) ??
    fallbackUuid();
}

// Fallback for the rare Node runtime that does not expose crypto.randomUUID.
// 24-byte hex string is non-RFC but sufficient for a local correlation id.
function fallbackUuid(): string {
  let out = "";
  for (let i = 0; i < 24; i++) {
    out += Math.floor(Math.random() * 16).toString(16);
  }
  return out;
}

function errorCode(err: unknown): string {
  const code = (err as { code?: unknown })?.code;
  if (typeof code === "string" && code.length > 0) {
    return code;
  }
  return "UNKNOWN";
}

function errorStatus(err: unknown): number | null {
  const status = (err as { status?: unknown })?.status;
  return typeof status === "number" ? status : null;
}
