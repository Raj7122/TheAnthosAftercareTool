import {
  computePriority,
  getActiveFactors,
  getActiveInvariants,
  getCalibrationConfiguration,
  type Configuration,
  type Factor,
  type TierInvariant,
} from "@anthos/domain";
import {
  getKnownBarrierTypes,
  hydrateCaseload,
  type BulkHydrationOptions,
  type CaseloadSnapshot,
} from "@anthos/integrations";

import { selectSalesforceAuth } from "../salesforce/select-auth.js";
import {
  degradedDto,
  scoredDto,
  type CalibrationParticipantDTO,
} from "./dto.js";
import { projectSnapshot } from "./snapshot-projection.js";

// Dependency overrides exist so tests can drive the orchestrator without
// hitting Salesforce or the real registries. Production calls pass nothing.
export interface GetCalibrationSetOptions {
  readonly ownerIds?: ReadonlyArray<string>;
  readonly factors?: ReadonlyArray<Factor>;
  readonly invariants?: ReadonlyArray<TierInvariant>;
  readonly configuration?: Configuration;
  readonly knownBarrierTypes?: ReadonlySet<string>;
  readonly hydrate?: (
    ownerId: string,
    opts?: BulkHydrationOptions,
  ) => Promise<{ snapshots: ReadonlyArray<CaseloadSnapshot> }>;
  readonly hydrateOptions?: BulkHydrationOptions;
  // The scoring clock — governs the snapshot→participant projection's
  // days-since / days-until / incident-window math. Tests inject a fixed
  // clock for determinism; production defaults to `new Date()`.
  readonly now?: () => Date;
}

// P0-11 calibration-only orchestrator.
//
// Reads the configured calibration cohort (CALIBRATION_OWNER_IDS env var),
// hydrates each owner's caseload via the P0-08 bulk adapter, scores each
// participant via computePriority(), and returns a flat list of
// CalibrationParticipantDTOs ready for the UI.
//
// When the factor registry is empty (factors === []), the engine cannot
// score and that participant emits a degraded DTO. P0-04f adds a
// per-participant guard: if the snapshot projection or computePriority()
// throws for one participant, that row degrades (with a structured warn)
// while the rest still score — the page never 500s.
//
// Read-only — no audit row required (Pattern B: pure GET).
export async function getCalibrationSet(
  options: GetCalibrationSetOptions = {},
): Promise<ReadonlyArray<CalibrationParticipantDTO>> {
  const ownerIds = options.ownerIds ?? parseOwnerIdsFromEnv();
  const factors = options.factors ?? getActiveFactors();
  const configuration = options.configuration ?? getCalibrationConfiguration();
  // P0-04a — invariant construction now needs both the active configuration
  // (for the M-CONFIG mapping) and the Salesforce Barrier Type enum cache
  // (for the fail-loud check at engine startup).
  const knownBarrierTypes = options.knownBarrierTypes ?? getKnownBarrierTypes();
  const invariants =
    options.invariants ?? getActiveInvariants(configuration, knownBarrierTypes);
  const hydrate = options.hydrate ?? hydrateCaseload;
  // P0-12a — hand the hydration adapter a concrete Salesforce auth so the
  // deployed BFF doesn't fall through to the `sf` CLI keychain (absent on
  // Vercel). A test-injected `hydrateOptions.auth` takes precedence; a fake
  // `hydrate` override bypasses this entirely.
  const hydrateOptions: BulkHydrationOptions = {
    ...options.hydrateOptions,
    auth: options.hydrateOptions?.auth ?? selectSalesforceAuth(),
  };
  // Resolved once so every participant in this call scores against an
  // identical instant. Distinct from `hydrateOptions.now`, which governs
  // `hydratedAt` (when Salesforce was read), not the scoring clock.
  const now = (options.now ?? (() => new Date()))();

  const dtos: CalibrationParticipantDTO[] = [];

  for (const ownerId of ownerIds) {
    const { snapshots } = await hydrate(ownerId, hydrateOptions);
    for (const snap of snapshots) {
      if (factors.length === 0) {
        dtos.push(degradedDto(snap.participantId, snap.ownerId, snap.hydratedAt));
        continue;
      }
      // Guard per participant: a factor (or the projection) that throws for
      // one participant degrades only that row — the rest still score.
      try {
        const engine = computePriority({
          participant: projectSnapshot(snap, configuration, now),
          configuration,
          factors,
          invariants,
        });
        dtos.push(
          scoredDto(snap.participantId, snap.ownerId, snap.hydratedAt, engine),
        );
      } catch (err) {
        logFactorDegradation(snap, err);
        dtos.push(
          degradedDto(snap.participantId, snap.ownerId, snap.hydratedAt),
        );
      }
    }
  }

  return dtos;
}

// Structured warn for a participant degraded by a throwing factor or
// projection. We never catch errors silently: this records the failure with
// Salesforce record IDs and the factor key only — no participant PII. Factor
// throw messages interpolate `typeof` / enum strings, never participant data,
// so `reason` is safe to log verbatim.
function logFactorDegradation(snap: CaseloadSnapshot, err: unknown): void {
  const reason = err instanceof Error ? err.message : String(err);
  // Factor throw messages lead with the factor key, e.g.
  // "stability_visit_state must be string, got undefined".
  const factorKey = reason.split(/[\s:]/, 1)[0] || "unknown";
  console.warn(
    JSON.stringify({
      event: "calibration.participant_degraded",
      participantId: snap.participantId,
      ownerId: snap.ownerId,
      factorKey,
      reason,
    }),
  );
}

function parseOwnerIdsFromEnv(): ReadonlyArray<string> {
  const raw = process.env["CALIBRATION_OWNER_IDS"] ?? "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
