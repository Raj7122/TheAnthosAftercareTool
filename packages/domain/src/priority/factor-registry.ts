import { factors } from "./factors/index.js";
import type { Factor } from "./types.js";

// Returns the active factor set: the BR-19 factors plus the BR-21 SBOP
// Pattern F stub. Factor (g) Arrears is registered as of P0-08c (Pattern F —
// computes a transparent value at config weight 0; see `factors/arrears.ts`).
// Factor (j) Confirmed AI signals is a Phase 3D / M-AI deliverable and is
// intentionally not registered — see `factors/index.ts` for the registry
// source of truth.
//
// Callers MUST pair this with a Configuration whose `factorWeights.additive`
// declares a weight for every returned key (VR-05 fail-loud). The Phase-0
// calibration UI uses `getCalibrationConfiguration()`, which merges
// the v0 candidate-weights baseline so all keys
// resolve. Production reads from the DB-backed Configuration row (ERD §6.6).
export function getActiveFactors(): ReadonlyArray<Factor> {
  return factors;
}
