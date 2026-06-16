import type { Configuration } from "../../config/index.js";
import type {
  Factor,
  FactorComputeResult,
  FactorSubContribution,
  HydratedParticipant,
} from "../types.js";

// BR-19(e) — Open Barriers (severity-weighted, staleness-bumped).
//
// NOTE: fixture mapping at packages/domain/test/priority/_fixtures.ts:148
// has (e) = open_barriers, (f) = unit_engagement (FS letter ordering is the
// inverse). The fixture is authoritative for engine routing — calibration
// profiles, candidate-weights JSON, and the agreement harness all bind to
// the fixture key names.
//
// Source: Barriers table filtered to Stage = 'Aftercare' AND End_Date is null
// (filter lives in packages/api/src/calibration/snapshot-projection.ts's
// deriveOpenBarriers; the engine consumes the projected list). Per-Barrier
// contribution = severity weight × staleness multiplier:
//   - severity weight: configuration.barrierSeverityHigh/Medium/Low keyed by
//     `barrierSeverityClassification[type]` (BR-37), with fallback to the
//     entry's `severity` field for fixtures that pre-classify.
//   - staleness multiplier (BR-39): when the barrier's Salesforce
//     `Days_Since_Last_Update__c` value is ≥
//     configuration.barrierStalenessThresholdDays, multiply the severity
//     contribution by configuration.barrierStalenessMultiplier; otherwise ×1.
//
// VR-05 / AC-15 fail-loud: the three severity weights, the staleness
// multiplier, and the threshold are required fields on the Zod
// configurationSchema — a parse failure at engine init catches missing or
// non-numeric values before the factor ever runs.

interface OpenBarrier {
  readonly id?: unknown;
  readonly type?: unknown;
  readonly severity?: unknown;
  readonly daysSinceLastUpdate?: unknown;
}

type Severity = "high" | "medium" | "low";

function readSeverity(value: unknown): Severity | undefined {
  return value === "high" || value === "medium" || value === "low"
    ? value
    : undefined;
}

function severityWeight(
  severity: Severity | undefined,
  configuration: Configuration,
): number {
  // Configuration stores severity weights as strings (numeric(5,2) in
  // Postgres → Drizzle returns string). Zod's refine already guaranteed
  // these are finite-numeric strings; Number() is a safe coercion here.
  switch (severity) {
    case "high":
      return Number(configuration.barrierSeverityHigh);
    case "medium":
      return Number(configuration.barrierSeverityMedium);
    case "low":
      return Number(configuration.barrierSeverityLow);
    default:
      return 0;
  }
}

function isStale(
  daysSinceLastUpdate: unknown,
  thresholdDays: number,
): boolean {
  return (
    typeof daysSinceLastUpdate === "number" &&
    Number.isFinite(daysSinceLastUpdate) &&
    daysSinceLastUpdate >= thresholdDays
  );
}

export const openBarriersFactor: Factor = {
  key: "open_barriers",
  displayName: "Open Barriers",
  type: "numeric",
  compute(
    participant: HydratedParticipant,
    configuration: Configuration,
  ): FactorComputeResult {
    const raw = participant["open_barriers"];
    if (raw === undefined || raw === null) {
      return { valueLabel: "0 open", valueNumeric: 0 };
    }
    if (!Array.isArray(raw)) {
      throw new Error(`open_barriers must be array, got ${typeof raw}`);
    }

    const classification = configuration.barrierSeverityClassification;
    const stalenessMultiplier = Number(configuration.barrierStalenessMultiplier);
    const thresholdDays = configuration.barrierStalenessThresholdDays;

    let total = 0;
    const counts = { high: 0, medium: 0, low: 0, unknown: 0 };
    const subContributions: FactorSubContribution[] = [];

    for (const entry of raw as ReadonlyArray<OpenBarrier>) {
      const type = typeof entry.type === "string" ? entry.type : "";
      // eslint-disable-next-line security/detect-object-injection -- typed lookup
      const configSeverity = type ? classification[type] : undefined;
      const severity =
        readSeverity(configSeverity) ?? readSeverity(entry.severity);
      const base = severityWeight(severity, configuration);
      const stale = isStale(entry.daysSinceLastUpdate, thresholdDays);
      const contribution = base * (stale ? stalenessMultiplier : 1);

      total += contribution;
      if (severity === "high") counts.high++;
      else if (severity === "medium") counts.medium++;
      else if (severity === "low") counts.low++;
      else counts.unknown++;

      const sub: FactorSubContribution = {
        label: type || "Unknown",
        valueNumeric: contribution,
        ...(severity !== undefined && { classification: severity }),
        ...(typeof entry.id === "string" && entry.id.length > 0
          ? { recordId: entry.id }
          : {}),
      };
      subContributions.push(sub);
    }

    const parts: string[] = [];
    if (counts.high > 0) parts.push(`${counts.high}h`);
    if (counts.medium > 0) parts.push(`${counts.medium}m`);
    if (counts.low > 0) parts.push(`${counts.low}l`);
    if (counts.unknown > 0) parts.push(`${counts.unknown}?`);

    const summary = parts.length > 0 ? ` (${parts.join("/")})` : "";

    // GAP-25 / GAP-26 picklist-extension stub (FS v1.12 §F-06 BR-37 v1.9
    // erratum). When a barrier's Type cannot be classified — neither
    // M-CONFIG nor the fixture severity could resolve it — surface a
    // dataQualityWarning so the calibration UI can flag it. This is the
    // pure-function analog of the ticket's "info-level log per participant"
    // stub. It lights up automatically when Anthos extends the Barriers
    // picklist (Tier 2 Q22 / Q23) and operators add the new Types to
    // configuration.barrierSeverityClassification — no code change required.
    const dataQualityWarning =
      counts.unknown > 0
        ? `barrier_type_unmapped_check_br25_br26 (${counts.unknown})`
        : undefined;

    return {
      valueLabel: `${raw.length} open${summary}`,
      valueNumeric: total,
      ...(subContributions.length > 0 && { subContributions }),
      ...(dataQualityWarning !== undefined && { dataQualityWarning }),
    };
  },
};
