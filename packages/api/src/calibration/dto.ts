import type {
  EngineOutput,
  FactorContribution,
  HighestImpactFactor,
  TriggeredInvariant as EngineTriggeredInvariant,
  TriggeredOverlapCap,
} from "@anthos/domain";

// API v1.3 wire shape for the TR-PRIORITY-7 v1.2 breakdown payload's
// invariant arm (TRD §1787, EC-12). Snake_case keys at the wire boundary;
// `triggering_record_id` is optional and OMITTED (not null) for aggregate
// invariants like BR-24. `adaptInvariant()` below is the camelCase→snake_case
// boundary; `scoredDto()` projects every engine TriggeredInvariant through it.
export interface TriggeredInvariant {
  readonly invariant_id: string;
  readonly display_label: string;
  readonly triggering_record_id?: string;
}

export type TriggeredInvariantEntry = TriggeredInvariant;

// Read-only DTO for the calibration UI. Carries the full engine output plus
// the participantId/ownerId for table display. `scored=false` rows are the
// degraded pre-P0-04 state (factor registry empty); the UI renders these
// with placeholder cells.
export interface CalibrationParticipantDTO {
  readonly participantId: string;
  readonly ownerId: string;
  readonly hydratedAt: Date;
  readonly scored: boolean;
  readonly priorityScore: number | null;
  readonly tier: number | null;
  readonly tierLabel: string | null;
  readonly highestImpactFactor: HighestImpactFactor | null;
  readonly factors: ReadonlyArray<FactorContribution>;
  readonly triggeredInvariants: ReadonlyArray<TriggeredInvariantEntry>;
  readonly triggeredCaps: ReadonlyArray<TriggeredOverlapCap>;
  readonly configurationVersion: number | null;
}

// Builders kept here so the orchestrator stays thin and the shapes have one
// definition. The `engine` shape is the live EngineOutput; if a future engine
// revision adds fields, only this builder needs to know.
export function scoredDto(
  participantId: string,
  ownerId: string,
  hydratedAt: Date,
  engine: EngineOutput,
): CalibrationParticipantDTO {
  return {
    participantId,
    ownerId,
    hydratedAt,
    scored: true,
    priorityScore: engine.priorityScore,
    tier: engine.tier,
    tierLabel: engine.tierLabel,
    highestImpactFactor: engine.highestImpactFactor,
    factors: engine.factors,
    triggeredInvariants: engine.triggeredInvariants.map(adaptInvariant),
    triggeredCaps: engine.triggeredCaps,
    configurationVersion: engine.configurationVersion,
  };
}

function adaptInvariant(entry: EngineTriggeredInvariant): TriggeredInvariant {
  return {
    invariant_id: entry.invariantId,
    display_label: entry.displayLabel,
    ...(entry.triggeringRecordId !== undefined && {
      triggering_record_id: entry.triggeringRecordId,
    }),
  };
}

export function degradedDto(
  participantId: string,
  ownerId: string,
  hydratedAt: Date,
): CalibrationParticipantDTO {
  return {
    participantId,
    ownerId,
    hydratedAt,
    scored: false,
    priorityScore: null,
    tier: null,
    tierLabel: null,
    highestImpactFactor: null,
    factors: [],
    triggeredInvariants: [],
    triggeredCaps: [],
    configurationVersion: null,
  };
}
