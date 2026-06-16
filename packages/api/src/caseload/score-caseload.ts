// scoreCaseload — single-owner hydrate → project → score kernel (P1C-01).
//
// Generalizes the `getCalibrationSet` loop to ONE caseload owner (the caller):
// one P0-08 bulk Salesforce hydrate, then one `projectSnapshot` +
// `computePriority` pass per participant, with a per-participant degradation
// guard so a single throwing factor degrades only that row (no
// silent catches — the degradation is structured-logged, never swallowed).
//
// It returns `ScoredParticipant[]` — the raw `CaseloadSnapshot` paired with its
// `EngineOutput` — NOT a wire DTO: the caseload endpoint (P1C-01) needs the
// snapshot to assemble the E-06 derived blocks (`stabilityVisit`,
// `openBarriers`, …) and to evaluate queue-membership predicates.
//
// PII (Immutable #1): the engine is opaque to participant identity
// (TR-PRIORITY-1); neither `EngineOutput` nor the snapshot fields this kernel
// touches carry participant names. The P0-08 hydrate path does not fetch them.

import {
  computePriority,
  getActiveFactors,
  getActiveInvariants,
  getCalibrationConfiguration,
  type Configuration,
  type EngineOutput,
  type Factor,
  type TierInvariant,
} from "@anthos/domain";
import {
  getKnownBarrierTypes,
  hydrateCaseload,
  type BulkHydrationOptions,
  type CaseloadSnapshot,
} from "@anthos/integrations";
import type { StructuredLogger } from "@anthos/logging";

import { selectSalesforceAuth } from "../salesforce/select-auth.js";
import { projectSnapshot } from "../calibration/snapshot-projection.js";

// One participant's hydrated snapshot paired with its engine result.
// `engine === null` IS the degraded signal — a factor or the projection threw.
export interface ScoredParticipant {
  readonly snapshot: CaseloadSnapshot;
  readonly engine: EngineOutput | null;
  readonly degraded: boolean;
}

export interface ScoreCaseloadOptions {
  // All seams default to the live registries / adapter; tests inject fakes.
  readonly factors?: ReadonlyArray<Factor>;
  readonly invariants?: ReadonlyArray<TierInvariant>;
  readonly configuration?: Configuration;
  readonly knownBarrierTypes?: ReadonlySet<string>;
  readonly hydrate?: typeof hydrateCaseload;
  readonly hydrateOptions?: BulkHydrationOptions;
  // The scoring clock — resolved once so every participant scores against an
  // identical instant. Defaults to `new Date()`.
  readonly now?: () => Date;
  // Optional trace-bound structured logger. When supplied (the caseload
  // endpoint passes its request-scoped child), participant-degradation events
  // are correlated by `trace_id`; absent, they fall back to `console.warn`.
  readonly logger?: StructuredLogger;
}

export interface ScoreCaseloadResult {
  readonly scored: ReadonlyArray<ScoredParticipant>;
  // TR-SF-2 round-trip metering, surfaced for the caseload.hydrated audit row.
  readonly roundTrips: number;
  readonly hydratedAt: Date;
  // Echoed so the caller assembles the E-06 derived blocks against the SAME
  // configuration + clock the engine scored with.
  readonly configuration: Configuration;
  readonly now: Date;
}

export async function scoreCaseload(
  ownerId: string,
  options: ScoreCaseloadOptions = {},
): Promise<ScoreCaseloadResult> {
  const factors = options.factors ?? getActiveFactors();
  const configuration = options.configuration ?? getCalibrationConfiguration();
  // Invariant construction needs both the active configuration (the M-CONFIG
  // mapping) and the Salesforce Barrier Type enum cache (fail-loud check).
  const knownBarrierTypes = options.knownBarrierTypes ?? getKnownBarrierTypes();
  const invariants =
    options.invariants ?? getActiveInvariants(configuration, knownBarrierTypes);
  const hydrate = options.hydrate ?? hydrateCaseload;
  // Hand the hydration adapter a concrete Salesforce auth so the deployed BFF
  // does not fall through to the `sf` CLI keychain (absent on Vercel). A
  // test-injected `hydrateOptions.auth` takes precedence.
  const hydrateOptions: BulkHydrationOptions = {
    ...options.hydrateOptions,
    auth: options.hydrateOptions?.auth ?? selectSalesforceAuth(),
  };
  const now = (options.now ?? (() => new Date()))();

  const { snapshots, roundTrips, hydratedAt } = await hydrate(
    ownerId,
    hydrateOptions,
  );

  const scored: ScoredParticipant[] = [];
  for (const snap of snapshots) {
    if (factors.length === 0) {
      // No active factor registry — the engine cannot score (pre-P0-04 state).
      scored.push({ snapshot: snap, engine: null, degraded: true });
      continue;
    }
    try {
      const engine = computePriority({
        participant: projectSnapshot(snap, configuration, now),
        configuration,
        factors,
        invariants,
      });
      scored.push({ snapshot: snap, engine, degraded: false });
    } catch (err) {
      // One throwing factor (or projection) degrades only this row; the rest
      // still score — the endpoint never 500s on a single bad participant.
      logParticipantDegradation(snap, err, options.logger);
      scored.push({ snapshot: snap, engine: null, degraded: true });
    }
  }

  return { scored, roundTrips, hydratedAt, configuration, now };
}

// Structured warn for a degraded participant. We never swallow errors
// silently: this records the failure with Salesforce record IDs and the factor
// key only — no participant PII. Factor throw messages interpolate `typeof` /
// enum strings, never participant data, so `reason` is safe to log verbatim.
// Routes through the trace-bound structured logger when one is supplied;
// otherwise `console.warn` (the calibration-orchestrator fallback).
function logParticipantDegradation(
  snap: CaseloadSnapshot,
  err: unknown,
  logger: StructuredLogger | undefined,
): void {
  const reason = err instanceof Error ? err.message : String(err);
  // Factor throw messages lead with the factor key, e.g.
  // "stability_visit_state must be string, got undefined".
  const factorKey = reason.split(/[\s:]/, 1)[0] || "unknown";
  const fields = {
    event: "caseload.participant_degraded",
    participantId: snap.participantId,
    ownerId: snap.ownerId,
    factorKey,
    reason,
  };
  if (logger !== undefined) {
    logger.warn("caseload participant degraded during scoring", fields);
    return;
  }
  console.warn(JSON.stringify(fields));
}
