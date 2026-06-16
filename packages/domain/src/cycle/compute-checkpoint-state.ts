// F-05 — Stability Visit Cycle: structural state computation.
//
// Pure function: same input → same output, no I/O, no side effects. The
// `currentDate` is an explicit parameter so tests can drive it (same
// discipline as `packages/domain/src/priority/compute.ts`).
//
// Implements: TR-STAB-1..4 anchor math, BR-28 due window, BR-29 overdue,
// BR-31 complete, BR-32 / FS-12 null start date, VR-10 future start date,
// AC-21 past-day-365 cycle end, BR-33 timeline-derived state aggregation
// (Catch-up = missed checkpoint behind next upcoming).
//
// BR-25 nearest-preceding credit attribution is delegated to
// `./credit-checkpoint.js` (P1D-02). BR-26 Option A catch-up clearance
// semantics → P1D-03. BR-30 `scheduled` state → blocked on `[TBD-v1.12-3]`
// scheduled-visit storage.
//
// Date semantics: EC-19 — UTC-day arithmetic, see `./date-utils.js`.

import { creditCheckpoint } from "./credit-checkpoint.js";
import { addDays, diffInDays, toUtcDayStart } from "./date-utils.js";
import {
  CHECKPOINT_ANCHORS,
  DEFAULT_DUE_WINDOW_DAYS,
  type CheckpointAnchor,
  type CheckpointState,
  type ComputeCheckpointStateInput,
  type ComputeCheckpointStateOutput,
} from "./types.js";

interface AnchorInfo {
  readonly anchor: CheckpointAnchor;
  readonly utcMs: number;
  readonly credited: boolean;
}

export function computeCheckpointState(
  input: ComputeCheckpointStateInput,
): ComputeCheckpointStateOutput {
  const dueWindowDays = input.dueWindowDays ?? DEFAULT_DUE_WINDOW_DAYS;

  // BR-32 / FS-12 — null aftercare start date is "Data issue — start date
  // missing"; surface as the not_in_cycle sentinel. F-03 factor wiring (a
  // later ticket) routes this to BR-19(b)'s documented default.
  if (input.aftercareStartDate === null) {
    return {
      checkpointState: "not_in_cycle",
      daysToNext: null,
      daysOverdue: 0,
      nextCheckpoint: null,
      lastCreditedCheckpoint: null,
    };
  }

  const startMs = toUtcDayStart(input.aftercareStartDate);
  const nowMs = toUtcDayStart(input.currentDate);

  // VR-10 — future-dated Aftercare start date is "Pre-enrollment"; all four
  // checkpoints are "Future." Surface the 90-day anchor as the next, so the
  // caller can render a countdown.
  if (startMs > nowMs) {
    const firstAnchorMs = addDays(startMs, 90);
    return {
      checkpointState: "pre_enrollment",
      daysToNext: diffInDays(firstAnchorMs, nowMs),
      daysOverdue: 0,
      nextCheckpoint: 90,
      lastCreditedCheckpoint: null,
    };
  }

  const anchors: AnchorInfo[] = CHECKPOINT_ANCHORS.map((anchor) => ({
    anchor,
    utcMs: addDays(startMs, anchor),
    credited: false,
  }));

  // BR-25 nearest-preceding credit attribution per `creditCheckpoint`. Each
  // visit credits at most one anchor; the `credited` boolean is idempotent,
  // so multiple visits that map to the same anchor do not re-credit it
  // (satisfies P1D-02 AC #5). Visit-attribution metadata (FS-13 "most recent
  // service date wins") is intentionally not surfaced at this layer — the
  // output only reports `lastCreditedCheckpoint`.
  for (const meeting of input.completedStabilityMeetings) {
    const creditedAnchor = creditCheckpoint(
      input.aftercareStartDate,
      meeting.serviceDate,
    );
    if (creditedAnchor === null) continue;
    const idx = anchors.findIndex((a) => a.anchor === creditedAnchor);
    if (idx !== -1) {
      const target = anchors[idx];
      if (target !== undefined) {
        anchors[idx] = { ...target, credited: true };
      }
    }
  }

  const lastCreditedAnchor = [...anchors]
    .reverse()
    .find((a) => a.credited);
  const lastCreditedCheckpoint: CheckpointAnchor | null =
    lastCreditedAnchor?.anchor ?? null;

  // AC-21 — past day 365 + due window, the cycle ceases. J-05 graduation
  // handling owns the broader participant lifecycle.
  const cycleEndMs = addDays(startMs, 365 + dueWindowDays);
  if (nowMs > cycleEndMs) {
    return {
      checkpointState: "cycle_complete",
      daysToNext: null,
      daysOverdue: 0,
      nextCheckpoint: null,
      lastCreditedCheckpoint,
    };
  }

  // Partition the anchors against `nowMs`. An anchor is "passed" if its
  // due date is on or before today; "future" otherwise. BR-29 makes
  // "overdue" begin one calendar day after the checkpoint with no credit,
  // so we treat "passed" as `anchorMs <= nowMs` and rely on the credit
  // check below to determine whether that anchor counts as missed.
  const passed = anchors.filter((a) => a.utcMs <= nowMs);
  const future = anchors.filter((a) => a.utcMs > nowMs);

  const uncreditedPassed = passed.filter((a) => !a.credited);
  const nextAnchor = future[0];

  // BR-33 / BR-29 — uncredited passed anchor(s) drive overdue vs. catch_up.
  // Rule: `overdue` when the single miss is the most-recent passed anchor
  // (the call-to-action is "satisfy the one that just slipped"). `catch_up`
  // whenever a miss is anywhere OTHER than the most-recent passed (i.e., a
  // miss sits behind a later credit, or multiple misses stack — BR-26
  // says a missed checkpoint "surfaces Catch-up persistently"). BR-27
  // co-displays catch_up + upcoming so the dual signal is preserved.
  if (uncreditedPassed.length > 0) {
    const mostRecentMiss = uncreditedPassed[uncreditedPassed.length - 1];
    if (mostRecentMiss === undefined) {
      // Unreachable — `.length > 0` proved it. Narrow keeps TS honest.
      throw new Error("internal: uncreditedPassed has length but no last");
    }
    const daysOverdue = diffInDays(nowMs, mostRecentMiss.utcMs);

    const mostRecentPassed = passed[passed.length - 1];
    const onlyMissIsMostRecentPassed =
      uncreditedPassed.length === 1 &&
      mostRecentPassed !== undefined &&
      !mostRecentPassed.credited;
    const state: CheckpointState = onlyMissIsMostRecentPassed
      ? "overdue"
      : "catch_up";

    return {
      checkpointState: state,
      daysToNext:
        nextAnchor !== undefined ? diffInDays(nextAnchor.utcMs, nowMs) : null,
      daysOverdue,
      nextCheckpoint: nextAnchor?.anchor ?? null,
      lastCreditedCheckpoint,
    };
  }

  // No uncredited passed anchor. BR-28 "Due" vs. BR-31 "Complete" /
  // "Between" depends on how close the next anchor is.
  if (nextAnchor === undefined) {
    // All four passed and all four credited and we haven't tripped
    // cycle_complete above — the participant sits in the 14-day grace
    // window after day 365. Surface as `complete`.
    return {
      checkpointState: "complete",
      daysToNext: null,
      daysOverdue: 0,
      nextCheckpoint: null,
      lastCreditedCheckpoint,
    };
  }

  const daysToNext = diffInDays(nextAnchor.utcMs, nowMs);
  const state: CheckpointState = daysToNext <= dueWindowDays ? "due" : "between";

  return {
    checkpointState: state,
    daysToNext,
    daysOverdue: 0,
    nextCheckpoint: nextAnchor.anchor,
    lastCreditedCheckpoint,
  };
}
