// Date helpers for caseload derived-block math (P1C-01). Whole-day deltas only
// — the caseload row carries integer "days" fields (`aftercareDay`,
// `voucherRecertDays`, barrier `ageDays`, …).

const MS_PER_DAY = 86_400_000;

// Whole elapsed days from `from` to `to`, floored. Negative when `to` precedes
// `from`. Matches the convention in `calibration/snapshot-projection.ts` so the
// caseload row and the engine's factor inputs agree on day counts.
export function wholeDaysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / MS_PER_DAY);
}

// `YYYY-MM-DD` (UTC) — the API v1.3 §7.3.1 date-only wire format for
// `stabilityVisit.nextDueDate`.
export function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
