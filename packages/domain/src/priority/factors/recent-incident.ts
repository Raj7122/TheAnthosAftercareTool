import type { Configuration } from "../../config/index.js";
import type {
  Factor,
  FactorComputeResult,
  HydratedParticipant,
} from "../types.js";

// BR-19(d) — Recent incident (30-day rolling window).
// Source: Incident records on the participant; each contributes for 30 days
// from logged date, then drops out (BR-19d window default 30, configurable
// via Configuration.recentIncidentWindowDays).
//
// Engine input: HydratedParticipant.recent_incident is a `boolean` in the
// Phase-0 calibration profiles — the windowed-or-not check is pre-computed
// during hydration. P0-08 may shift this to a structured count + dates; the
// factor will need to be revisited at that point. For now: boolean → 0/1.

export const recentIncidentFactor: Factor = {
  key: "recent_incident",
  displayName: "Recent incident (30-day window)",
  type: "numeric",
  compute(
    participant: HydratedParticipant,
    _configuration: Configuration,
  ): FactorComputeResult {
    const raw = participant["recent_incident"];
    if (raw === undefined || raw === null) {
      return { valueLabel: "no", valueNumeric: 0 };
    }
    if (typeof raw !== "boolean") {
      throw new Error(`recent_incident must be boolean, got ${typeof raw}`);
    }
    return raw
      ? { valueLabel: "yes (30-day window)", valueNumeric: 1 }
      : { valueLabel: "no", valueNumeric: 0 };
  },
};
