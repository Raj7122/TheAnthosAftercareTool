// F-05 Stability Visit Cycle — shared test fixtures for the P1D-05 matrix.
//
// Mirrors the pattern in `packages/domain/test/priority/_fixtures.ts`: one
// factory, one UTC-day helper, and every matrix test reads as a one-liner
// against a clear name. The fixture intentionally produces the same
// `ComputeCheckpointStateInput` shape consumed by all three P1D-01..P1D-03
// pure functions, so a single fixture drives `computeCheckpointState`,
// `creditCheckpoint`, and `computePerCheckpointStates`.

import type { ComputeCheckpointStateInput } from "../../src/cycle/index.js";

export function utcDate(yyyyMmDd: string): Date {
  return new Date(`${yyyyMmDd}T00:00:00Z`);
}

export interface MakeParticipantCycleArgs {
  readonly start: string | null;
  readonly today: string;
  readonly visits?: ReadonlyArray<string>;
  readonly dueWindowDays?: number;
}

export function makeParticipantCycle(
  args: MakeParticipantCycleArgs,
): ComputeCheckpointStateInput {
  const base: ComputeCheckpointStateInput = {
    aftercareStartDate: args.start === null ? null : utcDate(args.start),
    currentDate: utcDate(args.today),
    completedStabilityMeetings: (args.visits ?? []).map((d) => ({
      serviceDate: utcDate(d),
    })),
  };
  return args.dueWindowDays === undefined
    ? base
    : { ...base, dueWindowDays: args.dueWindowDays };
}
