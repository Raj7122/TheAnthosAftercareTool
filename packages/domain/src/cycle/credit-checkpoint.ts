// F-05 BR-25 — A visit is credited to the nearest *preceding* checkpoint
// based on completion date. Maps to TR-STAB-3 (TRD v1.8 §4.4): "Visit credit
// MUST apply to the nearest preceding checkpoint (BR-25)."
//
// Pure: same input → same output, no I/O. Operates on a single visit; the
// caller (e.g. `computeCheckpointState`) handles multi-visit aggregation.
// FS-13 visit-attribution metadata ("which Case Note IS the credit") is out
// of scope here — the function only answers which anchor receives credit.
//
// Examples (from FS v1.12 F-05 EC-15, EC-16 and the P1D-02 acceptance list):
//   day  90 → 90      day 200 → 180      day  89 → null
//   day 365 → 365     day 400 → 365      visit < start → null
//   null start date → null

import { diffInDays, toUtcDayStart } from "./date-utils.js";
import { CHECKPOINT_ANCHORS, type CheckpointAnchor } from "./types.js";

export function creditCheckpoint(
  aftercareStartDate: Date | null,
  completedVisitDate: Date,
): CheckpointAnchor | null {
  if (aftercareStartDate === null) {
    return null;
  }
  const offsetDays = diffInDays(
    toUtcDayStart(completedVisitDate),
    toUtcDayStart(aftercareStartDate),
  );
  // Largest anchor ≤ offsetDays. Walk descending so the first hit wins.
  for (let i = CHECKPOINT_ANCHORS.length - 1; i >= 0; i--) {
    // eslint-disable-next-line security/detect-object-injection -- bounded loop index into readonly anchor tuple
    const anchor = CHECKPOINT_ANCHORS[i];
    if (anchor !== undefined && offsetDays >= anchor) {
      return anchor;
    }
  }
  return null;
}
