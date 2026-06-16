// P1G-04 / TR-SF-8: nightly self-heal hard refresh per specialist at 02:00
// in each specialist's stored local timezone. Vercel cron triggers a single
// UTC schedule (hourly); this worker filters to specialists whose local hour
// at the current tick is the target (02), and for each match fires the
// shared `executeCaseloadRefresh` engine that backs P1G-01's manual handler.
//
// System-initiated path — bypasses the manual rate limit (P1G-02 / TR-SF-9)
// by calling `executeCaseloadRefresh` directly, NOT by smuggling a magic
// bypass header through the public POST /caseload/refresh endpoint. The
// rate-limit branch lives in `runRefreshCaseload` (the manual entry), so the
// cron path is naturally exempt.
//
// Idempotency: each (specialist, scheduled-run-ISO) pair maps to a
// deterministic UUIDv5 key. The cron acquires a row in `idempotency_keys`
// before calling the refresh engine; a retried cron tick (Vercel re-runs a
// failed invocation on schedule, or an operator hits the route manually)
// resolves the same key and skips specialists whose refresh has already
// committed within the 24h TTL. The audit row's `trace_id` carries the
// per-specialist trace so the audit_log → idempotency_keys join holds.
//
// Per-specialist failure isolation: one specialist's SF error or DB hiccup
// does NOT block the rest of the tick (ticket AC §3). Per-specialist
// outcomes roll up into the tick result for the cron route to surface.
//
// No outbound communications — Immutable #4 (quiet hours) is N/A. The 02:00
// window is for cache freshness, not messaging.

import { createHash } from "node:crypto";

import { ENV_ROLE_PERMISSION_SETS } from "../auth/callback-config.js";
import { selectSalesforceAuth } from "../salesforce/select-auth.js";
import { executeCaseloadRefresh } from "./refresh-caseload.js";
import type { RefreshCaseloadHandlerOptions } from "./refresh-caseload.js";

import type {
  SalesforceSpecialist,
  SalesforceRestClient,
  SoqlQueryClient,
} from "@anthos/integrations";
import type { StructuredLogger } from "@anthos/logging";
import type { DbOrTx } from "@anthos/persistence";

import type { IdempotencyStore } from "../idempotency/store.js";

// Wall-clock hour (0–23) at which the refresh fires in each specialist's
// local timezone. TR-SF-8 specifies 02:00 — exposed as a constant so the
// unit tests can pin the contract without re-encoding the magic number.
export const CRON_SPECIALIST_REFRESH_TARGET_LOCAL_HOUR = 2;

// Default IANA timezone applied when a specialist's SF `TimeZoneSidKey` is
// empty/null. Ticket §Notes: NYC default (the field-team baseline). Use the
// IANA id — `EST` / `EDT` would mis-handle DST transitions.
export const CRON_SPECIALIST_REFRESH_DEFAULT_TIMEZONE = "America/New_York";

// Namespace UUID for the cron's deterministic idempotency keys. Stable for
// the lifetime of the feature — changing it would orphan in-flight 24h TTL
// rows. A random v4 generated once and fixed (RFC 4122 §4.3 namespace).
const CRON_IDEMPOTENCY_NAMESPACE = "8c5d4e3a-7f1b-4a9c-b6e2-9d8f0c1a2b3d";

// Cron path's audit channel + the idempotency-keys row's `endpoint` label.
// The endpoint label is a stable identifier — analytics group by it.
const CRON_IDEMPOTENCY_ENDPOINT = "CRON /caseload/refresh";

// Per-specialist outcome of one cron tick — surfaced in the result summary
// so the route can log + the test harness can assert.
export type NightlyCaseloadRefreshCronOutcome =
  | { readonly specialistId: string; readonly status: "REFRESHED"; readonly httpStatus: number }
  | { readonly specialistId: string; readonly status: "SKIPPED_IDEMPOTENT" }
  | { readonly specialistId: string; readonly status: "SKIPPED_OFF_HOUR"; readonly localHour: number }
  | { readonly specialistId: string; readonly status: "FAILED"; readonly reason: string };

export interface NightlyCaseloadRefreshCronResult {
  readonly tickStartedAt: string;
  readonly targetLocalHour: number;
  readonly specialistsEnumerated: number;
  readonly specialistsConsidered: number;
  readonly specialistsRefreshed: number;
  readonly specialistsSkippedIdempotent: number;
  readonly specialistsFailed: number;
  readonly outcomes: ReadonlyArray<NightlyCaseloadRefreshCronOutcome>;
}

// Adapter seam — the cron only needs the `query` shape, not the full REST
// surface. The default builds a Connected App-backed client; tests inject a
// fake.
type SpecialistEnumerator = (
  client: SoqlQueryClient,
  permissionSetNames: ReadonlyArray<string>,
) => Promise<ReadonlyArray<SalesforceSpecialist>>;

export interface NightlyCaseloadRefreshCronOptions {
  // Server clock seam — defaults to `new Date()`. The same instant is reused
  // for both the local-hour filter and each per-specialist refresh's `now`.
  readonly now?: () => Date;
  // Override the SF client (tests inject a SOQL-only fake).
  readonly sfClient?: SoqlQueryClient;
  // Override the SF enumerator (tests inject a deterministic list, skipping
  // the SOQL round-trip entirely).
  readonly listSpecialists?: SpecialistEnumerator;
  // Permission-set names to filter SF Users by. Defaults to the keys of the
  // `ANTHOS_ROLE_PERMISSION_SETS` env var — the same source the auth
  // callback (P1B-02) reads. An empty list resolves to an empty tick
  // gracefully — the same FS-02 "not provisioned" closed-fail posture.
  readonly permissionSetNames?: ReadonlyArray<string>;
  // Refresh-engine seams — every dep that `executeCaseloadRefresh` needs to
  // run without the HTTP layer. Tests inject all of them; deployed runs
  // resolve defaults via the same dynamic-import path the manual handler
  // uses (keeps the DB connection side effect out of @anthos/api's static
  // import graph).
  readonly refreshOptions?: RefreshCaseloadHandlerOptions;
  // Idempotency store — defaults to the lazily-resolved Postgres store.
  // Tests inject a fake.
  readonly idempotencyStore?: IdempotencyStore;
  // DB handle — defaults to the lazily-resolved @anthos/persistence db. The
  // store and `refreshOptions.db` should share it.
  readonly db?: DbOrTx;
  // Structured logger — defaults to a fresh `api.caseload.cron_refresh`
  // logger. Tests inject a spy.
  readonly logger?: StructuredLogger;
  // Trace-id factory — defaults to `crypto.randomUUID`. Tests inject a
  // deterministic stub so audit / idempotency joins are assertable.
  readonly traceIdFactory?: () => string;
  // Override the target local hour — defaults to
  // `CRON_SPECIALIST_REFRESH_TARGET_LOCAL_HOUR` (02). Tests use this to
  // exercise alternate hours without pinning system time globally.
  readonly targetLocalHour?: number;
  // Override the default fallback timezone — defaults to
  // `CRON_SPECIALIST_REFRESH_DEFAULT_TIMEZONE`. Tests use this to assert the
  // fallback wiring.
  readonly defaultTimezone?: string;
}

// Vercel cron entry point. One tick = enumerate, filter, refresh sequentially.
// Sequential is the right cadence for ~12 specialists: it naturally staggers
// the SF reads and fits comfortably inside Vercel's 300s function timeout.
export async function runNightlyCaseloadRefreshCron(
  options: NightlyCaseloadRefreshCronOptions = {},
): Promise<NightlyCaseloadRefreshCronResult> {
  const log = options.logger ?? (await defaultLogger());
  const nowFn = options.now ?? (() => new Date());
  const now = nowFn();
  const tickStartedAt = now.toISOString();
  const targetLocalHour =
    options.targetLocalHour ?? CRON_SPECIALIST_REFRESH_TARGET_LOCAL_HOUR;
  const defaultTimezone =
    options.defaultTimezone ?? CRON_SPECIALIST_REFRESH_DEFAULT_TIMEZONE;
  const traceIdFactory = options.traceIdFactory ?? defaultTraceIdFactory;

  const permissionSetNames =
    options.permissionSetNames ?? resolveRolePermissionSetNames();

  // Step 1: enumerate. An empty perm-set list short-circuits to a zero
  // result — same closed-fail posture as the auth callback when
  // `ANTHOS_ROLE_PERMISSION_SETS` is unpopulated (P1B-02). Log loud so the
  // operator knows the cron is a no-op until Erik provisions the perm sets.
  if (permissionSetNames.length === 0) {
    log.warn("nightly caseload refresh cron: no permission sets configured", {
      event: "cron_refresh_no_perm_sets",
      tick_started_at: tickStartedAt,
    });
    return emptyResult(tickStartedAt, targetLocalHour);
  }

  const specialists = await enumerateSpecialists(
    options,
    permissionSetNames,
    log,
  );

  // Step 2 + 3: filter to local-02:00, then fire sequentially. The tick's
  // "scheduled run" is `now` floored to the hour; the deterministic
  // idempotency key uses that ISO so a retry of THE SAME tick collapses to
  // the same row, but a fresh tick the next day gets its own row.
  const scheduledRunISO = floorToHourISO(now);
  const outcomes: NightlyCaseloadRefreshCronOutcome[] = [];
  let considered = 0;
  let refreshed = 0;
  let skippedIdempotent = 0;
  let failed = 0;

  for (const specialist of specialists) {
    const tz = specialist.timezone.length > 0
      ? specialist.timezone
      : defaultTimezone;
    const localHour = computeLocalHour(now, tz, log, specialist.specialistId);
    if (localHour !== targetLocalHour) {
      outcomes.push({
        specialistId: specialist.specialistId,
        status: "SKIPPED_OFF_HOUR",
        localHour,
      });
      continue;
    }
    considered += 1;
    const outcome = await refreshOneSpecialist({
      specialistId: specialist.specialistId,
      scheduledRunISO,
      options,
      traceIdFactory,
      log,
    });
    outcomes.push(outcome);
    if (outcome.status === "REFRESHED") refreshed += 1;
    else if (outcome.status === "SKIPPED_IDEMPOTENT") skippedIdempotent += 1;
    else if (outcome.status === "FAILED") failed += 1;
  }

  log.info("nightly caseload refresh cron tick complete", {
    event: "cron_refresh_tick_complete",
    tick_started_at: tickStartedAt,
    specialists_enumerated: specialists.length,
    specialists_considered: considered,
    specialists_refreshed: refreshed,
    specialists_skipped_idempotent: skippedIdempotent,
    specialists_failed: failed,
  });

  return {
    tickStartedAt,
    targetLocalHour,
    specialistsEnumerated: specialists.length,
    specialistsConsidered: considered,
    specialistsRefreshed: refreshed,
    specialistsSkippedIdempotent: skippedIdempotent,
    specialistsFailed: failed,
    outcomes,
  };
}

// ── one-specialist path ─────────────────────────────────────────────────────

interface RefreshOneInput {
  readonly specialistId: string;
  readonly scheduledRunISO: string;
  readonly options: NightlyCaseloadRefreshCronOptions;
  readonly traceIdFactory: () => string;
  readonly log: StructuredLogger;
}

async function refreshOneSpecialist(
  input: RefreshOneInput,
): Promise<NightlyCaseloadRefreshCronOutcome> {
  const { specialistId, scheduledRunISO, options, traceIdFactory } = input;
  const traceId = traceIdFactory();
  const log = input.log.child({ traceId, specialistId });
  const idempotencyKey = deriveCronIdempotencyKey(specialistId, scheduledRunISO);

  let store: IdempotencyStore;
  try {
    store = await resolveIdempotencyStore(options);
  } catch (err) {
    log.error("nightly caseload refresh cron: idempotency store unresolved", {
      event: "cron_refresh_idem_store_unresolved",
      reason: errorReason(err),
    });
    return {
      specialistId,
      status: "FAILED",
      reason: errorReason(err),
    };
  }

  // Acquire the deterministic lock. `null` = a prior cron run (same tick,
  // same specialist) is already in-flight or COMPLETED; SKIP cleanly so the
  // refresh engine isn't re-entered.
  let acquired: Awaited<ReturnType<IdempotencyStore["acquire"]>>;
  try {
    acquired = await store.acquire({
      key: idempotencyKey,
      specialistId,
      endpoint: CRON_IDEMPOTENCY_ENDPOINT,
      requestHash: scheduledRunISO,
      traceId,
    });
  } catch (err) {
    log.error("nightly caseload refresh cron: idempotency acquire failed", {
      event: "cron_refresh_idem_acquire_failed",
      reason: errorReason(err),
    });
    return {
      specialistId,
      status: "FAILED",
      reason: errorReason(err),
    };
  }
  if (acquired === null) {
    log.info("nightly caseload refresh cron: specialist already refreshed", {
      event: "cron_refresh_skipped_idempotent",
      scheduled_run: scheduledRunISO,
    });
    return { specialistId, status: "SKIPPED_IDEMPOTENT" };
  }

  // Lock held — run the refresh engine. Mark COMPLETED on 2xx, FAILED on
  // 4xx (terminal — stays cached so an on-schedule retry skips), DELETE on
  // 5xx (releasable — a Vercel re-invoke can succeed).
  const refreshOptions = options.refreshOptions ?? {};
  try {
    const response = await executeCaseloadRefresh(
      { specialistId, traceId },
      refreshOptions,
      log,
      "cron",
    );
    const httpStatus = response.status;
    const bodyText = await response.clone().text();
    const responseBody = parseBodyOrNull(bodyText);

    if (httpStatus >= 200 && httpStatus < 400) {
      await store.markCompleted(idempotencyKey, httpStatus, responseBody);
      return {
        specialistId,
        status: "REFRESHED",
        httpStatus,
      };
    }
    if (httpStatus >= 400 && httpStatus < 500) {
      await store.markFailedTerminal(idempotencyKey, httpStatus, responseBody);
      log.warn("nightly caseload refresh cron: refresh failed (terminal)", {
        event: "cron_refresh_failed_terminal",
        http_status: httpStatus,
      });
      return {
        specialistId,
        status: "FAILED",
        reason: `http_${httpStatus}`,
      };
    }
    // 5xx — release the key for a future retry.
    await store.delete(idempotencyKey);
    log.warn("nightly caseload refresh cron: refresh failed (releasable)", {
      event: "cron_refresh_failed_releasable",
      http_status: httpStatus,
    });
    return {
      specialistId,
      status: "FAILED",
      reason: `http_${httpStatus}`,
    };
  } catch (err) {
    // Thrown / network / non-SalesforceError engine error: release the key
    // so the next cron tick (or operator-triggered run) can retry, and
    // surface the failure in the tick result.
    try {
      await store.delete(idempotencyKey);
    } catch (deleteErr) {
      log.error("nightly caseload refresh cron: lock release failed", {
        event: "cron_refresh_lock_release_failed",
        reason: errorReason(deleteErr),
      });
    }
    log.error("nightly caseload refresh cron: refresh engine threw", {
      event: "cron_refresh_engine_threw",
      reason: errorReason(err),
    });
    return {
      specialistId,
      status: "FAILED",
      reason: errorReason(err),
    };
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

// Read the auth callback's perm-set map and return the set of perm-set API
// names. Returns `[]` when the env var is unset, empty, or malformed —
// the caller treats an empty list as the no-op posture.
function resolveRolePermissionSetNames(): ReadonlyArray<string> {
  // eslint-disable-next-line security/detect-object-injection
  const raw = process.env[ENV_ROLE_PERMISSION_SETS];
  if (raw === undefined || raw.trim().length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return [];
    }
    return Object.keys(parsed as Record<string, unknown>);
  } catch {
    return [];
  }
}

// Compute the wall-clock hour (0–23) at `now` in `tz` using
// `Intl.DateTimeFormat` — handles DST without a date library. A bad TZ
// throws; we catch, log, and return -1 (no match against the target hour).
//
// DST corollary (known, acceptable): on the spring-forward night the local
// clock jumps from 01:59 → 03:00 in many zones (e.g., `America/New_York`),
// so no UTC instant maps to local 02:xx — every NYC-TZ specialist is
// skipped that one night a year. The self-heal cron is a freshness
// optimization, not a correctness invariant, so one missed night is
// acceptable; the next 02:00 tick re-aligns the cache. T_DST in the test
// file pins this behavior so a future change does not silently start
// double-refreshing during the duplicated fall-back 02:xx hour.
function computeLocalHour(
  now: Date,
  tz: string,
  log: StructuredLogger,
  specialistId: string,
): number {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "numeric",
      hour12: false,
    });
    const parts = fmt.formatToParts(now);
    const hourPart = parts.find((p) => p.type === "hour");
    if (hourPart === undefined) return -1;
    const parsed = Number.parseInt(hourPart.value, 10);
    if (!Number.isFinite(parsed)) return -1;
    // `hour: numeric` + `hour12: false` returns "24" at midnight in some
    // ICU builds. Normalize 24 → 0 so the comparison against the target
    // hour is well-defined.
    return parsed === 24 ? 0 : parsed;
  } catch (err) {
    log.warn("nightly caseload refresh cron: bad timezone for specialist", {
      event: "cron_refresh_bad_timezone",
      specialist_id: specialistId,
      timezone: tz,
      reason: errorReason(err),
    });
    return -1;
  }
}

// `now` floored to the hour, as ISO 8601 UTC. The scheduled-run identifier
// — used inside the deterministic idempotency key — so a retry of the same
// hourly tick collapses to the same key.
function floorToHourISO(now: Date): string {
  const floored = new Date(now.getTime());
  floored.setUTCMinutes(0, 0, 0);
  return floored.toISOString();
}

// Deterministic UUIDv5 over `cron:caseload.refresh:{specialistId}:{scheduledRunISO}`.
// The `idempotency_keys.key` column is Postgres `uuid`, so a raw composite
// string can't be stored — UUIDv5 (RFC 4122 §4.3, name-based SHA-1) makes
// the recipe a valid UUID while keeping it deterministic.
function deriveCronIdempotencyKey(
  specialistId: string,
  scheduledRunISO: string,
): string {
  const name = `cron:caseload.refresh:${specialistId}:${scheduledRunISO}`;
  return uuidV5(name, CRON_IDEMPOTENCY_NAMESPACE);
}

// UUIDv5 — name-based, SHA-1. Concatenate the namespace's 16 bytes with the
// UTF-8 `name`, take the SHA-1, set the version (5) and variant (RFC 4122)
// bits, and format as 8-4-4-4-12 hex. Stays in node:crypto — no `uuid`
// package dependency to add. Mirrors the standard RFC 4122 §4.3 algorithm.
function uuidV5(name: string, namespaceUuid: string): string {
  const namespaceBytes = parseUuidToBytes(namespaceUuid);
  const nameBytes = Buffer.from(name, "utf8");
  const hash = createHash("sha1")
    .update(namespaceBytes)
    .update(nameBytes)
    .digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  // Version 5 (0101xxxx in the top nibble of byte 6).
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  // Variant RFC 4122 (10xxxxxx in the top two bits of byte 8).
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
    `${hex.slice(16, 20)}-${hex.slice(20, 32)}`
  );
}

// Strip dashes + decode 16 bytes of hex. Throws if `uuid` is malformed —
// the namespace constant is module-internal, so a throw here is operator
// error caught in dev.
function parseUuidToBytes(uuid: string): Buffer {
  const hex = uuid.replace(/-/g, "");
  if (hex.length !== 32 || !/^[0-9a-f]+$/i.test(hex)) {
    throw new Error(`invalid UUID: ${uuid}`);
  }
  return Buffer.from(hex, "hex");
}

function defaultTraceIdFactory(): string {
  return (
    (globalThis.crypto?.randomUUID?.() as string | undefined) ?? fallbackUuid()
  );
}

// 24-byte hex string — non-RFC, sufficient for a local correlation id when
// `crypto.randomUUID` is unavailable. Mirrors `sf-cdc-poll.ts`'s fallback.
function fallbackUuid(): string {
  let out = "";
  for (let i = 0; i < 24; i++) {
    out += Math.floor(Math.random() * 16).toString(16);
  }
  return out;
}

function parseBodyOrNull(text: string): unknown {
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function errorReason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function emptyResult(
  tickStartedAt: string,
  targetLocalHour: number,
): NightlyCaseloadRefreshCronResult {
  return {
    tickStartedAt,
    targetLocalHour,
    specialistsEnumerated: 0,
    specialistsConsidered: 0,
    specialistsRefreshed: 0,
    specialistsSkippedIdempotent: 0,
    specialistsFailed: 0,
    outcomes: [],
  };
}

// ── dep resolution (dynamic-import for the deployed path) ───────────────────

async function defaultLogger(): Promise<StructuredLogger> {
  const { createLogger } = await import("@anthos/logging");
  return createLogger({ module: "api.caseload.cron_refresh" });
}

async function enumerateSpecialists(
  options: NightlyCaseloadRefreshCronOptions,
  permissionSetNames: ReadonlyArray<string>,
  log: StructuredLogger,
): Promise<ReadonlyArray<SalesforceSpecialist>> {
  const enumerator =
    options.listSpecialists ?? (await defaultListSpecialists());
  const client = options.sfClient ?? (await buildDefaultSalesforceClient());
  try {
    return await enumerator(client, permissionSetNames);
  } catch (err) {
    // Enumeration failure halts the tick — without a specialist list we
    // can't refresh anyone. Log loud and return empty (no-op tick); the
    // next cron invocation retries on its own schedule.
    log.error("nightly caseload refresh cron: enumeration failed", {
      event: "cron_refresh_enumeration_failed",
      reason: errorReason(err),
    });
    return [];
  }
}

async function defaultListSpecialists(): Promise<SpecialistEnumerator> {
  const { listSpecialists } = await import("@anthos/integrations");
  return listSpecialists;
}

async function buildDefaultSalesforceClient(): Promise<SalesforceRestClient> {
  const { SalesforceRestClient: Client } = await import("@anthos/integrations");
  return new Client({ auth: selectSalesforceAuth() });
}

let defaultIdempotencyStorePromise: Promise<IdempotencyStore> | undefined;

async function resolveIdempotencyStore(
  options: NightlyCaseloadRefreshCronOptions,
): Promise<IdempotencyStore> {
  if (options.idempotencyStore !== undefined) {
    return options.idempotencyStore;
  }
  defaultIdempotencyStorePromise ??= import(
    "../idempotency/postgres-store.js"
  ).then((m) => m.createDefaultPostgresStore());
  return defaultIdempotencyStorePromise;
}
