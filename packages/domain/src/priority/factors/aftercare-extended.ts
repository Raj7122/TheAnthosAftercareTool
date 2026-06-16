import type { Configuration } from "../../config/index.js";
import type {
  Factor,
  FactorComputeResult,
  HydratedParticipant,
} from "../types.js";

// BR-19(h) — Aftercare Extended status.
// Source: `Aftercare Extended` checkbox on the Program Enrollment record.
// Rationale (Julia): an extension is granted when someone has already
// determined the participant needs higher-touch support, so the flag is
// itself a positive priority signal. Weight is calibration-tuned.
//
// Engine reads this factor's result twice: once via the standard breakdown
// row (additive contribution), once via `compute.ts` to populate
// EngineOutput.priorityModifier as a display label per API v1.3 §7.3.1.

export const aftercareExtendedFactor: Factor = {
  key: "aftercare_extended",
  displayName: "Aftercare Extended",
  type: "numeric",
  compute(
    participant: HydratedParticipant,
    _configuration: Configuration,
  ): FactorComputeResult {
    const raw = participant["aftercare_extended"];
    if (raw === undefined || raw === null) {
      return { valueLabel: "Not extended", valueNumeric: 0 };
    }
    if (typeof raw !== "boolean") {
      throw new Error(`aftercare_extended must be boolean, got ${typeof raw}`);
    }
    return raw
      ? { valueLabel: "Extended", valueNumeric: 1 }
      : { valueLabel: "Not extended", valueNumeric: 0 };
  },
};
