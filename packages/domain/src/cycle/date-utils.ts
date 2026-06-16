// EC-19 — checkpoint anchors use date-only arithmetic so DST transitions
// cannot shift a due date. We normalize every input Date to its midnight-UTC
// date marker and do day arithmetic in `Date.UTC`.
//
// Shared between `compute-checkpoint-state.ts` (P1D-01) and
// `credit-checkpoint.ts` (P1D-02) so both layers agree on the date scale.

export const MS_PER_DAY = 86_400_000;

export function toUtcDayStart(date: Date): number {
  return Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
  );
}

export function addDays(utcMs: number, days: number): number {
  return utcMs + days * MS_PER_DAY;
}

export function diffInDays(laterMs: number, earlierMs: number): number {
  return Math.round((laterMs - earlierMs) / MS_PER_DAY);
}
