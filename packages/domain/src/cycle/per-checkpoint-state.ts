// F-05 BR-26 — Per-checkpoint state (Option A catch-up semantics).
//
// Pure function: same input → same output, no I/O, no `Date.now()`. Returns
// one `PerCheckpointBreakdown` per anchor in ascending order, or an empty
// array when no cycle exists (null aftercare start date, BR-32 / FS-12).
//
// Option A — confirmed by Julia, 6 May 2026 (FS v1.12 §F-05 BR-26): a missed
// checkpoint surfaces a Catch-up state immediately and persistently, clearing
// ONLY when a Case Note with `Type='Stability Meeting'`, `Status='Completed'`
// and a service date that credits THAT anchor (per BR-25) is logged.
// Completing a later checkpoint does NOT clear an earlier miss — Option B
// explicitly rejected. P1D-04 reads this breakdown to render the BR-33
// 5-state timeline (Green / Grey / Orange / Red / Purple+!).
//
// The aggregate `computeCheckpointState` (P1D-01) mirrors the same anchor
// classification but collapses it into a single participant-level state for
// the F-03 stability-visit factor (BR-19(b)). This function is the per-anchor
// expansion of that logic and reuses `creditCheckpoint` (P1D-02 / BR-25) for
// visit attribution.

import { creditCheckpoint } from "./credit-checkpoint.js";
import { addDays, toUtcDayStart } from "./date-utils.js";
import {
  CHECKPOINT_ANCHORS,
  DEFAULT_DUE_WINDOW_DAYS,
  type CheckpointAnchor,
  type ComputeCheckpointStateInput,
  type PerAnchorState,
  type PerCheckpointBreakdown,
} from "./types.js";

export function computePerCheckpointStates(
  input: ComputeCheckpointStateInput,
): ReadonlyArray<PerCheckpointBreakdown> {
  if (input.aftercareStartDate === null) {
    return [];
  }

  const dueWindowDays = input.dueWindowDays ?? DEFAULT_DUE_WINDOW_DAYS;
  const startMs = toUtcDayStart(input.aftercareStartDate);
  const nowMs = toUtcDayStart(input.currentDate);

  const credited = new Set<CheckpointAnchor>();
  for (const meeting of input.completedStabilityMeetings) {
    const anchor = creditCheckpoint(
      input.aftercareStartDate,
      meeting.serviceDate,
    );
    if (anchor !== null) {
      credited.add(anchor);
    }
  }

  // Most-recent passed anchor: largest anchor whose absolute date is on or
  // before today, regardless of credit status. Used to distinguish BR-29
  // `overdue` (the freshest miss) from BR-26 / BR-33 `catch_up` (a miss
  // anywhere else — behind a later credit OR behind a still-uncredited but
  // more-recent miss). The "no credit" half of "fresh miss with no credit"
  // is enforced upstream in `classify()`: the `credited.has(anchor)` guard
  // returns `complete` before the `overdue`/`catch_up` branch is reached,
  // so this value is only consulted for uncredited anchors. When
  // `aftercareStartDate > nowMs` (VR-10 pre-enrollment) no anchor has
  // passed yet and every entry shortcircuits to `future` before this value
  // is consulted.
  let mostRecentPassed: CheckpointAnchor | null = null;
  for (const anchor of CHECKPOINT_ANCHORS) {
    if (addDays(startMs, anchor) <= nowMs) {
      mostRecentPassed = anchor;
    }
  }

  return CHECKPOINT_ANCHORS.map((anchor) => ({
    anchor,
    state: classify(anchor, startMs, nowMs, dueWindowDays, credited, mostRecentPassed),
  }));
}

function classify(
  anchor: CheckpointAnchor,
  startMs: number,
  nowMs: number,
  dueWindowDays: number,
  credited: ReadonlySet<CheckpointAnchor>,
  mostRecentPassed: CheckpointAnchor | null,
): PerAnchorState {
  if (credited.has(anchor)) {
    return "complete";
  }
  const anchorMs = addDays(startMs, anchor);
  // BR-28 — "Due" begins N days before the anchor; before that window the
  // anchor is `future` (BR-33 Grey). Uses strict inequality so the day a
  // checkpoint enters its lead-time window classifies as `due`, matching
  // the boundary semantics of the aggregate function.
  if (nowMs < addDays(anchorMs, -dueWindowDays)) {
    return "future";
  }
  if (nowMs <= anchorMs) {
    return "due";
  }
  // BR-29 — anchor passed without credit. `overdue` if it's the freshest
  // miss (most-recent passed anchor); `catch_up` otherwise (Option A:
  // earlier misses persist regardless of later credits).
  return anchor === mostRecentPassed ? "overdue" : "catch_up";
}
