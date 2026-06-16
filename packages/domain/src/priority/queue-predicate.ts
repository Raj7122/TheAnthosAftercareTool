// Queue-predicate evaluation (F-04 BR-22, TR-QUEUE-1; P1C-01).
//
// A work queue's membership is decided by its `QueuePredicate` — one of the
// four discriminated `kind`s authored into M-CONFIG by P1C-05. This module is
// the pure evaluator the caseload endpoint (P1C-01) runs once per participant
// per queue: BR-21 fixes within-queue *ordering* to priority score, but the
// predicate decides *membership*.
//
// Pure: same `(predicate, input, now)` → same boolean, no I/O, no mutation —
// it belongs in `packages/domain` (no Salesforce, no integration imports).
// It deliberately does NOT take a `CaseloadSnapshot` (that is an
// `@anthos/integrations` type); `packages/api` derives the flat
// `QueueMembershipInput` from the snapshot, mirroring the `HydratedParticipant`
// projection seam so the domain stays integration-free.

import type { QueuePredicate } from "../config/index.js";

// The minimal per-participant facts the four predicate kinds need. The caller
// (P1C-01) derives every field from the hydrated snapshot; the day-delta
// fields are already resolved against the same `now` passed below.
//
// `daysUntilNextCheckIn` / `nextCheckInDate`: `EnrollmentSnapshot` carries no
// dedicated "next monthly check-in" date — the only forward-looking date
// hydrated is the stability-checkpoint formula (`dueDates.upcoming`). P1C-01
// uses that as the proxy and flags the limitation; documented here so a later
// ticket that hydrates a true monthly cadence swaps the caller's derivation
// alone, not this evaluator.
export interface QueueMembershipInput {
  // Whole days since the most recent successful contact; `null` = never
  // successfully contacted (BR-15 never-contacted sentinel).
  readonly daysSinceLastSuccessfulContact: number | null;
  // True once the participant has any successful contact on record.
  readonly hasEverBeenSuccessfullyContacted: boolean;
  // BR-19(c) failed contact attempts (Status='Attempted' rollup).
  readonly failedAttempts: number;
  // Whole days until the next check-in / stability checkpoint; `null` when no
  // forward-looking due date exists. Negative when the date is already past.
  readonly daysUntilNextCheckIn: number | null;
  // The next check-in / stability-checkpoint date — used only by the
  // `currentCalendarMonthOnly` arm of `successful_contact_overdue`.
  readonly nextCheckInDate: Date | null;
}

// Returns whether a participant belongs to the queue defined by `predicate`.
// `now` is the scoring clock — only the `currentCalendarMonthOnly` arm reads
// it directly; the day-delta fields on `input` were already computed against
// the same instant by the caller.
export function evaluateQueuePredicate(
  predicate: QueuePredicate,
  input: QueueMembershipInput,
  now: Date,
): boolean {
  switch (predicate.kind) {
    // BR-22 "Caseload overview": the hydrated caseload is already scoped to
    // the specialist's active participants, so every row qualifies (VR-08).
    case "all_active":
      return true;

    // BR-22 "Due soon": a check-in / stability checkpoint due within `days`.
    // EC-13 — a participant 31 days out is excluded, so the bound is
    // inclusive (`<=`); a past-due date (negative delta) is excluded (`>= 0`).
    case "due_within_days": {
      const days = input.daysUntilNextCheckIn;
      return days !== null && days >= 0 && days <= predicate.params.days;
    }

    // BR-22 "Never successfully contacted": zero successful contacts ever AND
    // at least `minFailedAttempts` failed attempts.
    case "never_successfully_contacted":
      return (
        !input.hasEverBeenSuccessfullyContacted &&
        input.failedAttempts >= predicate.params.minFailedAttempts
      );

    // BR-22 "Check-ins due this month": last successful contact is at least
    // `minDaysSinceContact` days old AND, when `currentCalendarMonthOnly`, the
    // next check-in falls in the current calendar month. A null
    // days-since-contact (never contacted) does NOT satisfy this predicate —
    // that population is the `never_successfully_contacted` queue's concern.
    case "successful_contact_overdue": {
      const daysSince = input.daysSinceLastSuccessfulContact;
      if (
        daysSince === null ||
        daysSince < predicate.params.minDaysSinceContact
      ) {
        return false;
      }
      if (!predicate.params.currentCalendarMonthOnly) {
        return true;
      }
      // "Current calendar month" — compared in UTC: snapshot dates land as
      // UTC `Date`s, and the participant-local-timezone concern (quiet hours)
      // is a separate layer that must not leak into queue membership.
      const next = input.nextCheckInDate;
      return (
        next !== null &&
        next.getUTCFullYear() === now.getUTCFullYear() &&
        next.getUTCMonth() === now.getUTCMonth()
      );
    }

    // Exhaustiveness guard: a future `QueuePredicate` kind added to the
    // discriminated union without a case here fails loud rather than silently
    // admitting (or excluding) every participant.
    default: {
      const unhandled: never = predicate;
      throw new Error(
        `evaluateQueuePredicate: unhandled predicate kind ${JSON.stringify(unhandled)}`,
      );
    }
  }
}
