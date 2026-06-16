import type { Configuration } from "../../config/index.js";
import type {
  Factor,
  FactorComputeResult,
  HydratedParticipant,
} from "../types.js";

// BR-19(a) — Days since last successful contact.
// Source: `Most Recent Successful Contact` formula field on Program Enrollment
// (Salesforce; deployed by Erik 5 May 2026). Path-B operative: a Case Note
// with Status IN ('Completed', 'Seen by Other Provider') counts as successful.
//
// Engine input: HydratedParticipant.days_since_last_contact is `number | null`
// (see Phase0ProfileFactors). Per TR-PRIORITY-14 + BR-15 + EC-08, a null
// value (never-contacted participant) MUST contribute the maximum factor
// value so never-contacted participants surface for attention and likely
// classify Tier 1.
//
// The value is capped at `configuration.daysSinceContactScoringCapDays`
// (90 — quarterly visit cadence). The cap lands on a real operational
// boundary rather than a runaway sentinel: a 67-day gap contributes 67, a
// 120-day gap contributes 90, and the never-contacted case maps to that same
// 90 ceiling. BR-15 intent is preserved — at the calibrated weight (3.0) a
// capped value of 90 contributes 270 ≫ tier1_min (80), so never-contacted
// still reliably tops the tier, while a stacked active case can still
// approach it (the cap stops days-since-contact from drowning every other
// factor). Negative values clamp to 0.

export const daysSinceLastContactFactor: Factor = {
  key: "days_since_last_contact",
  displayName: "Days since last successful contact",
  type: "numeric",
  compute(
    participant: HydratedParticipant,
    configuration: Configuration,
  ): FactorComputeResult {
    const cap = configuration.daysSinceContactScoringCapDays;
    const raw = participant["days_since_last_contact"];
    if (raw === null || raw === undefined) {
      return {
        valueLabel: `never contacted (capped at ${cap}d, BR-15)`,
        valueNumeric: cap,
      };
    }
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      throw new Error(
        `days_since_last_contact must be number|null, got ${typeof raw}`,
      );
    }
    const clamped = raw < 0 ? 0 : raw;
    const capped = clamped > cap ? cap : clamped;
    const valueLabel =
      capped < clamped ? `${clamped} days (capped at ${cap}d)` : `${clamped} days`;
    return { valueLabel, valueNumeric: capped };
  },
};
