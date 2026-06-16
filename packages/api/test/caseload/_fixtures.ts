import type { EngineOutput } from "@anthos/domain";
import type { CaseloadSnapshot } from "@anthos/integrations";

import type { ScoredParticipant } from "../../src/caseload/score-caseload.js";

// The calibration suite already has general-purpose CaseloadSnapshot builders
// (all-null defaults; override to light up a field) — reuse them here.
export {
  dueDatesWith,
  makeArrear,
  makeBarrier,
  makeIncident,
  makeSnapshot,
} from "../calibration/_fixtures.js";

// A minimal valid EngineOutput. Override `priorityScore` to exercise the
// BR-21 within-queue sort; override `factors` / `triggeredInvariants` to
// exercise the breakdown DTO assembly.
export function makeEngineOutput(
  participantId: string,
  overrides: Partial<EngineOutput> = {},
): EngineOutput {
  return {
    participantId,
    configurationVersion: 0,
    priorityScore: 50,
    tier: 2,
    tierLabel: "Plan this week",
    priorityModifier: null,
    highestImpactFactor: {
      name: "Days since last successful contact",
      key: "days_since_last_contact",
      valueLabel: "10 days",
      weight: "×1.5",
      pointsContributed: 15,
    },
    factors: [],
    triggeredInvariants: [],
    triggeredCaps: [],
    suppressionOverride: null,
    ...overrides,
  };
}

// Pairs a snapshot with its engine result. `engine === null` IS the degraded
// signal (a factor or the projection threw).
export function makeScored(
  snapshot: CaseloadSnapshot,
  engine: EngineOutput | null,
): ScoredParticipant {
  return { snapshot, engine, degraded: engine === null };
}
