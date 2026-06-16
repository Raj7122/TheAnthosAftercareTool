import type { Configuration } from "../../config/index.js";
import type {
  Factor,
  FactorComputeResult,
  HydratedParticipant,
} from "../types.js";

// BR-19(b) — Stability visit state.
// Source: pre-computed Salesforce formula fields (`Aftercare {First..Fourth}
// Due Date`, `Upcoming Aftercare Due Date`) reduced to a single state per FS
// v1.12. Only Case Notes with Type = 'Stability Meeting' credit a checkpoint.
//
// Engine input: HydratedParticipant.stability_visit_state is one of
// "on_track" | "upcoming" | "missed" | "catchup" (Phase0ProfileFactors).
// Mapping is monotonic in priority signal: on_track contributes nothing,
// missed dominates. Magnitudes are unitless ordinals; weights tune in P0-14.

const STATE_VALUES: Record<string, { numeric: number; label: string }> = {
  on_track: { numeric: 0, label: "On track" },
  upcoming: { numeric: 1, label: "Upcoming" },
  catchup: { numeric: 2, label: "Catch-up" },
  missed: { numeric: 3, label: "Missed" },
};

export const stabilityVisitStateFactor: Factor = {
  key: "stability_visit_state",
  displayName: "Stability visit state",
  type: "categorical",
  compute(
    participant: HydratedParticipant,
    _configuration: Configuration,
  ): FactorComputeResult {
    const raw = participant["stability_visit_state"];
    if (typeof raw !== "string") {
      throw new Error(
        `stability_visit_state must be string, got ${typeof raw}`,
      );
    }
    // eslint-disable-next-line security/detect-object-injection -- enum lookup
    const mapped = STATE_VALUES[raw];
    if (mapped === undefined) {
      throw new Error(`stability_visit_state: unknown value '${raw}'`);
    }
    return { valueLabel: mapped.label, valueNumeric: mapped.numeric };
  },
};
