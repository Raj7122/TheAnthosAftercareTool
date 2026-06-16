import type { Factor } from "../types.js";
import { aftercareExtendedFactor } from "./aftercare-extended.js";
import { arrearsFactor } from "./arrears.js";
import { daysSinceLastContactFactor } from "./days-since-last-contact.js";
import { failedAttemptsFactor } from "./failed-attempts.js";
import { openBarriersFactor } from "./open-barriers.js";
import { recentIncidentFactor } from "./recent-incident.js";
import { sbopFactor } from "./sbop.js";
import { stabilityVisitStateFactor } from "./stability-visit-state.js";
import { unitEngagementFactor } from "./unit-engagement.js";
import { voucherRecertDeadlineFactor } from "./voucher-recert-deadline.js";

// Active factor set: the BR-19 factors P0-04 implements plus the BR-21 SBOP
// Pattern F stub. Factor (g) Arrears is registered here as of P0-08c at config
// weight 0 — Pattern F: it computes a transparent value but contributes 0
// points until the FS §F-03 BR-19(g) erratum ratifies it and P0-14 calibrates
// the weight (see arrears.ts). Factor (j) Confirmed AI signals is a Phase 3D /
// M-AI deliverable (ADR-08) and is not registered.
//
// BR-19 factor (e) `unit_engagement` is NOT in the active set — retired per
// the 2026-05-20 Q15 Option B decision (its only input is the unresolved Q15
// stub; P0-04f cannot project it). `unitEngagementFactor` and its unit tests
// remain below so the module and the calibration-profile contract are
// undisturbed; only the active registry drops it.
export const factors: ReadonlyArray<Factor> = [
  daysSinceLastContactFactor,
  stabilityVisitStateFactor,
  failedAttemptsFactor,
  recentIncidentFactor,
  openBarriersFactor,
  arrearsFactor,
  aftercareExtendedFactor,
  voucherRecertDeadlineFactor,
  sbopFactor,
];

export {
  aftercareExtendedFactor,
  arrearsFactor,
  daysSinceLastContactFactor,
  failedAttemptsFactor,
  openBarriersFactor,
  recentIncidentFactor,
  sbopFactor,
  stabilityVisitStateFactor,
  unitEngagementFactor,
  voucherRecertDeadlineFactor,
};
