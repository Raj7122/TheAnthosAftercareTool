import type { Configuration } from "../../config/index.js";
import type {
  Factor,
  FactorComputeResult,
  HydratedParticipant,
} from "../types.js";

// BR-21 — SBOP (Seen by Other Provider) factor.
//
// Pattern F stub-and-ratchet.
//
// While Configuration.sbopEnabled is false (the default), this factor
// contributes exactly 0 priority points. The flag flips only on Anthos
// leadership ratification of BR-21 (GAP-9) — NOT on Demo→Production
// substrate migration. When ratification lands, the implementation of
// Path A / Path B / Path C compute is added INSIDE this function — there
// is no separate "production" file, no rewrite. One function, parameterized.
//
// Engine determinism (TR-PRIORITY-4) MUST hold at both flag states.
// Today, both branches return 0; the `true` branch is the placeholder for
// the ratification-time logic.

export const sbopFactor: Factor = {
  key: "sbop",
  displayName: "SBOP",
  type: "numeric",
  compute(
    _participant: HydratedParticipant,
    configuration: Configuration,
  ): FactorComputeResult {
    if (!configuration.sbopEnabled) {
      return { valueLabel: "sbop disabled", valueNumeric: 0 };
    }
    // BR-21 GAP-9 ratification will implement Path A/B/C compute here.
    // Until then the enabled branch also returns 0 — flipping the flag
    // without writing the logic must not yield non-deterministic scores.
    return { valueLabel: "sbop (pending GAP-9)", valueNumeric: 0 };
  },
};
