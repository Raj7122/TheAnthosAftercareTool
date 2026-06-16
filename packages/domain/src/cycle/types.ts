// F-05 Stability Visit Cycle — structural types.
//
// CheckpointState is the rich, UI-facing enum consumed by the P1D-04 badge
// layer (BR-33 five-state per-checkpoint timeline + the boundary states
// FS-12 / VR-10 / AC-21 carve out). Distinct from BR-19(b)'s compressed
// engine-factor input (`on_track | upcoming | missed | catchup`) which lives
// at `packages/domain/src/priority/factors/stability-visit-state.ts`; the
// mapping from this enum down to that factor input is P1D-02's concern.
//
// `scheduled` (BR-30) is deliberately absent: P1D-01's input is the
// completed-visit stream only, and scheduled-visit storage is
// `[TBD-v1.12-3]` pending Erick. A future ticket adds the input + state
// when the storage decision lands.

export type CheckpointState =
  | "not_in_cycle"      // BR-32 / FS-12: aftercare_start_date is null.
  | "pre_enrollment"    // VR-10: aftercare_start_date is in the future.
  | "future"            // BR-33 Grey: per-anchor only — checkpoint not yet reached (outside BR-28 lead-time window). `computeCheckpointState` aggregates this as `pre_enrollment` or `between` and never emits `future` directly; `computePerCheckpointStates` (P1D-03) emits it for individual anchors.
  | "complete"          // BR-31: most recent passed checkpoint has a credited visit.
  | "due"               // BR-28: next checkpoint within DUE_WINDOW_DAYS, no credit.
  | "overdue"           // BR-29: 1+ day past a checkpoint with no credit; no older miss.
  | "catch_up"          // BR-33 Purple+!: missed checkpoint sits behind the next upcoming one.
  | "between"           // BR-31 adjacent — last passed checkpoint credited; next is beyond DUE window. [INFERRED — confirm]: the spec names the per-checkpoint visualization states (BR-33) and the high-level user-story states (Complete / Scheduled / Due / Overdue / Catch-up) but does not enumerate this aggregate "credited and not yet in due window" state by label. Name ratified by P1D-04 badge work.
  | "cycle_complete";   // AC-21: past day 365 + DUE window; J-05 owns broader handling.

export type CheckpointAnchor = 90 | 180 | 270 | 365;

export const CHECKPOINT_ANCHORS: ReadonlyArray<CheckpointAnchor> = [
  90, 180, 270, 365,
] as const;

// BR-28 — "Due" status begins N days before the checkpoint. Spec recommends
// N = 14 [INFERRED — confirm]. Surfaced as an input override for tests and
// for the day a calibration sprint revises N.
export const DEFAULT_DUE_WINDOW_DAYS = 14;

export interface CompletedStabilityMeeting {
  // VR-11: a credited visit's service date must be ≤ today. Caller enforces.
  readonly serviceDate: Date;
}

export interface ComputeCheckpointStateInput {
  readonly aftercareStartDate: Date | null;
  readonly currentDate: Date;
  readonly completedStabilityMeetings: ReadonlyArray<CompletedStabilityMeeting>;
  readonly dueWindowDays?: number;
}

// BR-26 Option A per-anchor breakdown — P1D-03. One entry per
// `CHECKPOINT_ANCHORS` value, in ascending anchor order. The aggregate-only
// `CheckpointState` values (`not_in_cycle`, `pre_enrollment`, `between`,
// `cycle_complete`) are excluded by the type system because they're
// participant-level, not per-anchor — leaving the BR-33 5-state
// visualization subset (`future` | `due` | `complete` | `overdue` |
// `catch_up`).
export type PerAnchorState = Exclude<
  CheckpointState,
  "not_in_cycle" | "pre_enrollment" | "between" | "cycle_complete"
>;

export interface PerCheckpointBreakdown {
  readonly anchor: CheckpointAnchor;
  readonly state: PerAnchorState;
}

export interface ComputeCheckpointStateOutput {
  readonly checkpointState: CheckpointState;
  // Days from currentDate to the next upcoming anchor. Always non-negative
  // when present (the function only nominates anchors strictly in the future
  // as `nextCheckpoint`). null when there is no next anchor — i.e., the
  // cycle has ended (`cycle_complete`, `complete` at end-of-cycle) or the
  // participant has no Aftercare start date (`not_in_cycle`). The "missed
  // direction" signal is carried by `daysOverdue` below, not by a sign flip
  // on this field. The ticket's stated "negative if overdue" surface was
  // superseded by this two-field split during P1D-01 design (see
  // `cycle/compute-checkpoint-state.ts` for the routing logic).
  readonly daysToNext: number | null;
  // 0 when no checkpoint is in a missed state; otherwise days since the most
  // recent uncredited passed anchor (always ≥ 1 when non-zero).
  readonly daysOverdue: number;
  readonly nextCheckpoint: CheckpointAnchor | null;
  readonly lastCreditedCheckpoint: CheckpointAnchor | null;
}
