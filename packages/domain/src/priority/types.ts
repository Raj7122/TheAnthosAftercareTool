import type { Configuration } from "../config/index.js";
import type { TriggeredOverlapCap } from "./overlap-caps.js";

// HydratedParticipant — opaque to the engine. P0-04 declares the per-factor
// fields each Factor reads; P0-08 hydrates from Salesforce. Engine never
// reaches out to a system of record (Immutable #1 + TR-PRIORITY-1).
export interface HydratedParticipant {
  readonly participantId: string;
  readonly hydratedAt: Date;
  readonly [factorKey: string]: unknown;
}

// VR-07 factor type enum. Extend in P0-04 if a new shape lands; do not widen
// to `string` — type-checking is the only thing standing between a misnamed
// config key and a wrong score.
export type FactorType = "numeric" | "categorical";

export interface FactorComputeResult {
  readonly valueLabel: string;
  readonly valueNumeric: number;
  // P0-04d / BR-19(i) — per-factor data-quality signal. Populated when the
  // factor's input is technically valid but smells stale (e.g. voucher recert
  // deadline already past due — Julia 2026-05-19 hedge: "almost always stale
  // data, though we have no way of truly knowing"). UI surfaces a chip;
  // calibration may treat warned rows differently from clean ones. Per-factor
  // (not per-engine-output) so multiple factors can warn independently.
  readonly dataQualityWarning?: string;
  // P1E-03 / BR-19(e) — per-item breakdown for factors that aggregate over a
  // collection (open_barriers sums per Barrier). Populated so the P0-11
  // calibration UI can show individual contributions ("Barrier X: high → 4.5;
  // staleness ×1.5 → 6.75") rather than a single opaque total. Absent on
  // scalar factors. Engine routing reads `valueNumeric` (the aggregate);
  // `subContributions` is presentation-only.
  readonly subContributions?: ReadonlyArray<FactorSubContribution>;
}

// P1E-03 — one row of a factor's per-item breakdown. `label` is the
// human-readable subject (Barrier Type for open_barriers). `valueNumeric` is
// the post-multiplier per-item contribution that sums to the factor's
// aggregate. `classification` tags the row with a severity tier when the
// factor is a severity-weighted aggregate (BR-37). `recordId` is optional —
// when present, calibration UI can deep-link to the source record.
export interface FactorSubContribution {
  readonly label: string;
  readonly valueNumeric: number;
  readonly classification?: "high" | "medium" | "low";
  readonly recordId?: string;
}

// A Factor is a pure declaration. P0-04 implements nine of these.
// `key` MUST match a key in `configuration.factorWeights.additive` —
// VR-05 fail-loud catches mismatches at engine entry.
//
// `compute()` receives the active Configuration so factors that need
// config-derived thresholds (factor (i) voucher recert window, BR-21 SBOP
// flag, BR-37 barrier severity classification) can read them without a
// closure or a module-level singleton. The participant remains the only
// per-participant input — purity (TR-PRIORITY-1, Immutable #1) is preserved.
export interface Factor {
  readonly key: string;
  readonly displayName: string;
  readonly type: FactorType;
  compute(
    participant: HydratedParticipant,
    configuration: Configuration,
  ): FactorComputeResult;
}

// One row of the per-factor breakdown payload (API v1.3 §7.3.1).
// `key` is internal — BFF strips it from the API response; calibration and
// audit consumers bind to it.
export interface FactorContribution {
  readonly name: string;
  readonly key: string;
  readonly valueLabel: string;
  readonly valueNumeric: number;
  readonly weight: string;
  readonly weightRaw: number;
  readonly pointsContributed: number;
  readonly trend?: "up" | "down" | "flat";
  // P0-04d — propagated verbatim from FactorComputeResult.dataQualityWarning.
  // Flows straight to the wire DTO (dto.ts passes engine.factors through).
  readonly dataQualityWarning?: string;
  // P1E-03 — propagated verbatim from FactorComputeResult.subContributions.
  // Present for severity-weighted aggregates (open_barriers); absent for
  // scalar factors. The DTO layer passes this through to the calibration UI.
  readonly subContributions?: ReadonlyArray<FactorSubContribution>;
}

export interface HighestImpactFactor {
  readonly name: string;
  readonly key: string;
  readonly valueLabel: string;
  readonly weight: string;
  readonly pointsContributed: number;
}

// TierInvariant.check() result. `label` carries the human-readable invariant
// name (TRD §1787 `display_label`); `triggeringRecordId` is optional because
// aggregate invariants like BR-24 (failed_attempts ≥ N) have no single record.
export interface TierInvariantCheckResult {
  readonly triggered: boolean;
  readonly label: string;
  readonly floorTier: number;
  readonly triggeringRecordId?: string;
}

export interface TierInvariant {
  readonly id: string;
  check(
    participant: HydratedParticipant,
    contributions: ReadonlyArray<FactorContribution>,
  ): TierInvariantCheckResult;
}

// Structured record surfaced on EngineOutput.triggeredInvariants — the
// invariant arm of the TR-PRIORITY-7 v1.2 per-factor breakdown payload
// (TRD §1787, EC-12). Engine keys are camelCase; the API DTO adapter in
// packages/api/src/calibration/dto.ts converts to snake_case wire keys
// `{invariant_id, display_label, triggering_record_id}` so the UI can label
// the invariant as the "Primary Factor" and deep-link to the triggering
// record. `triggeringRecordId` is optional — aggregate invariants like BR-24
// (failed_attempts ≥ N) have no single record to link to.
export interface TriggeredInvariant {
  readonly invariantId: string;
  readonly displayLabel: string;
  readonly triggeringRecordId?: string;
}

// P0-04b — BR-21 Path C suppression state passed in by hydration. The engine
// does not compute whether the participant is currently "Snoozed"; that is a
// caller concern (Path C suppression substrate is a Pattern F stub today —
// `sbopEnabled=false` — and Phase-0 callers pass `undefined`, leaving the
// TR-PRIORITY-18 interaction rule as a no-op until Path C ratifies).
//
// `state` is a literal so a future extension can widen to a discriminated
// union without breaking callers. Today's single shape: presence of the
// `suppression` field on EngineInput signals "snoozed"; absence signals
// "not snoozed". There is no third "checked, not snoozed" representation —
// the BFF treats those identically, so the engine collapses them.
export interface SuppressionState {
  readonly state: "snoozed";
  readonly snoozedUntil?: Date;
}

// P0-04b — emitted on EngineOutput when an invariant fires for a participant
// in "Snoozed" suppression AND the configured override direction is the
// default (`invariant_override_suppression: true`). Downstream BFF authoring
// of the `Type='System Note'` Case Note (TR-PRIORITY-18, AR-01) consumes
// this payload verbatim. `null` on EngineOutput when no override fires —
// `suppressionOverride !== null` IS the "cleared" signal, no extra field
// needed.
export interface SuppressionOverride {
  readonly reason: "invariant_override_suppression";
  readonly invariantIds: ReadonlyArray<string>;
}

export interface EngineInput {
  readonly participant: HydratedParticipant;
  readonly configuration: Configuration;
  readonly factors: ReadonlyArray<Factor>;
  readonly invariants?: ReadonlyArray<TierInvariant>;
  readonly suppression?: SuppressionState;
}

export interface EngineOutput {
  readonly participantId: string;
  readonly configurationVersion: number;
  readonly priorityScore: number;
  readonly tier: number;
  readonly tierLabel: string;
  readonly priorityModifier: string | null;
  readonly highestImpactFactor: HighestImpactFactor;
  readonly factors: ReadonlyArray<FactorContribution>;
  readonly triggeredInvariants: ReadonlyArray<TriggeredInvariant>;
  readonly triggeredCaps: ReadonlyArray<TriggeredOverlapCap>;
  readonly suppressionOverride: SuppressionOverride | null;
}
