import type { Configuration } from "../../config/index.js";
import type {
  Factor,
  FactorComputeResult,
  HydratedParticipant,
} from "../types.js";

// BR-19(f) — Unit engagement state.
// NOTE on letter ordering: per fixture at _fixtures.ts:126 the engine routes
// `unit_engagement` as (f) — the FS spec assigns (f) to Open Barriers, but
// the fixture is authoritative. See open-barriers.ts header for context.
//
// Engine input: HydratedParticipant.unit_engagement is one of
// "stable" | "strained" | "crisis" (Phase0ProfileFactors). Mapping is
// monotonic — crisis dominates. Magnitudes are unitless ordinals; weights
// tune in P0-14.

const STATE_VALUES: Record<string, { numeric: number; label: string }> = {
  stable: { numeric: 0, label: "Stable" },
  strained: { numeric: 1, label: "Strained" },
  crisis: { numeric: 2, label: "Crisis" },
};

export const unitEngagementFactor: Factor = {
  key: "unit_engagement",
  displayName: "Unit engagement state",
  type: "categorical",
  compute(
    participant: HydratedParticipant,
    _configuration: Configuration,
  ): FactorComputeResult {
    const raw = participant["unit_engagement"];
    if (typeof raw !== "string") {
      throw new Error(`unit_engagement must be string, got ${typeof raw}`);
    }
    // eslint-disable-next-line security/detect-object-injection -- enum lookup
    const mapped = STATE_VALUES[raw];
    if (mapped === undefined) {
      throw new Error(`unit_engagement: unknown value '${raw}'`);
    }
    return { valueLabel: mapped.label, valueNumeric: mapped.numeric };
  },
};
