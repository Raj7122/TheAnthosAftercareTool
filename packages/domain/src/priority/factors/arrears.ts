import type { Configuration } from "../../config/index.js";
import type {
  Factor,
  FactorComputeResult,
  HydratedParticipant,
} from "../types.js";

// BR-19(g) — Arrears state.
//
// Pattern F stub-and-ratchet (sbop.ts is
// the live in-repo precedent). This factor computes a real, transparent value
// now — but it is registered at config weight 0 (calibration-config.ts +
// candidate-weights/v0.json), so it contributes exactly 0 priority points and
// cannot move a score. The weight stays 0 until the FS §F-03 BR-19(g) erratum
// ratifies the factor (closes open issue D-10) and P0-14 calibrates it up.
//
// Source: the Arrear__c sibling collection hydrated by P0-08b into
// CaseloadSnapshot.arrears. The P0-04 mapping layer will project that
// collection onto participant["arrears"]; that projection is a deferred stub
// shared by all BR-19 factors, so until it lands this factor degrades
// gracefully to "no arrears".
//
// Compute rule (v1 — deliberately a plain count for transparency): the numeric
// value is the count of arrears in an OPEN status. ArrearSnapshot also carries
// estimatedAmount / amountPaid / lengthOfTimeMonths and four dates — richer
// signals (amount-weighting, recency) the v1 rule ignores on purpose. Refining
// the rule is the FS erratum's + P0-14's job, not this factor's.

// Arrear__c.Status__c — restricted 5-value picklist (P0-08b, validated against
// the anthos-demo sandbox 2026-05-19). `Approved` (Anthos committed to pay,
// cash not yet moved) is treated as OPEN per the P0-08b default. Erick may
// reclassify it via P0-09b — that is a one-line move of the literal between
// the two sets below; with weight 0 the choice has zero score impact until
// P0-14, so the flip is rework-free.
const ARREAR_STATUS = {
  open: new Set<string>(["Identified", "Under Review", "Approved"]),
  closed: new Set<string>([
    "Resolved With Anthos Payment",
    "Resolved Without Anthos Payment",
  ]),
} as const;

// Domain-local input shape — packages/domain stays pure and free of any
// @anthos/integrations dependency, so the factor declares the one field it
// reads rather than importing ArrearSnapshot. Mirrors OpenBarrier in
// open-barriers.ts.
interface ArrearInput {
  readonly status?: unknown;
}

export const arrearsFactor: Factor = {
  key: "arrears",
  displayName: "Arrears",
  type: "numeric",
  compute(
    participant: HydratedParticipant,
    _configuration: Configuration,
  ): FactorComputeResult {
    const raw = participant["arrears"];
    if (raw === undefined || raw === null) {
      return { valueLabel: "no arrears", valueNumeric: 0 };
    }
    if (!Array.isArray(raw)) {
      throw new Error(`arrears must be array, got ${typeof raw}`);
    }

    let openCount = 0;
    for (const entry of raw as ReadonlyArray<ArrearInput>) {
      if (
        typeof entry.status === "string" &&
        ARREAR_STATUS.open.has(entry.status)
      ) {
        openCount++;
      }
    }

    if (openCount === 0) {
      return { valueLabel: "no arrears", valueNumeric: 0 };
    }
    const noun = openCount === 1 ? "arrear" : "arrears";
    return {
      valueLabel: `${openCount} open ${noun}`,
      valueNumeric: openCount,
    };
  },
};
