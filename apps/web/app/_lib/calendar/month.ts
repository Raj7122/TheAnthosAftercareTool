// Vanilla month-grid math for the participant activity calendar. No date
// library (no new deps without an ADR). Everything is keyed by a
// UTC `YYYY-MM-DD` string, matching the UTC-day arithmetic the rest of the app
// already uses for checkpoint dates (`CycleBreakdownPanel.anchorDateLabel`) so
// an event and its day cell always line up.

const MS_PER_DAY = 86_400_000;

export interface MonthCell {
  readonly ymd: string; // UTC YYYY-MM-DD
  readonly day: number; // 1..31
  readonly inMonth: boolean; // false for leading/trailing days
  readonly isToday: boolean;
}

export interface MonthMatrix {
  readonly year: number;
  readonly month: number; // 0..11
  readonly weeks: ReadonlyArray<ReadonlyArray<MonthCell>>;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

// UTC `YYYY-MM-DD` for a Date.
export function ymdKeyUtc(date: Date): string {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(
    date.getUTCDate(),
  )}`;
}

// Parse any ISO date or datetime to its UTC `YYYY-MM-DD`, or null if
// unparseable. "2026-05-29" → "2026-05-29"; a timestamp normalizes to its UTC
// calendar day (consistent with the app's UTC-day convention).
export function isoToYmd(iso: string | null): string | null {
  if (iso === null || iso === "") return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  return ymdKeyUtc(new Date(ms));
}

export function todayYmdUtc(now: Date = new Date()): string {
  return ymdKeyUtc(now);
}

// Year/month containing a `YYYY-MM-DD`, or null.
export function monthOfYmd(
  ymd: string | null,
): { readonly year: number; readonly month: number } | null {
  if (ymd === null) return null;
  const ms = Date.parse(ymd);
  if (Number.isNaN(ms)) return null;
  const d = new Date(ms);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() };
}

export function addMonths(
  year: number,
  month: number,
  delta: number,
): { readonly year: number; readonly month: number } {
  const total = year * 12 + month + delta;
  return { year: Math.floor(total / 12), month: ((total % 12) + 12) % 12 };
}

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

export function monthLabel(year: number, month: number): string {
  return `${MONTH_NAMES[month]} ${year}`;
}

export const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

const WEEKDAY_LONG = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;
const MONTH_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

// "Fri, May 29, 2026" from a UTC `YYYY-MM-DD` (UTC getters to match the keying).
// Returns the input unchanged if it is not a parseable date. Shared by the
// calendar surfaces (participant timeline + caseload activity calendar).
export function formatYmdLong(ymd: string): string {
  const ms = Date.parse(ymd);
  if (Number.isNaN(ms)) return ymd;
  const d = new Date(ms);
  return `${WEEKDAY_LONG[d.getUTCDay()]}, ${MONTH_SHORT[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

// Sunday-start 6×7 matrix for the given month. Leading/trailing cells come
// from the adjacent months (`inMonth: false`). `todayKey` defaults to the real
// UTC today; tests pass a fixed key.
export function buildMonthMatrix(
  year: number,
  month: number,
  todayKey: string = todayYmdUtc(),
): MonthMatrix {
  const firstOfMonthMs = Date.UTC(year, month, 1);
  const firstWeekday = new Date(firstOfMonthMs).getUTCDay(); // 0=Sun
  const gridStartMs = firstOfMonthMs - firstWeekday * MS_PER_DAY;

  const weeks: MonthCell[][] = [];
  for (let w = 0; w < 6; w += 1) {
    const row: MonthCell[] = [];
    for (let d = 0; d < 7; d += 1) {
      const cellMs = gridStartMs + (w * 7 + d) * MS_PER_DAY;
      const cell = new Date(cellMs);
      const ymd = ymdKeyUtc(cell);
      row.push({
        ymd,
        day: cell.getUTCDate(),
        inMonth: cell.getUTCMonth() === month,
        isToday: ymd === todayKey,
      });
    }
    weeks.push(row);
  }
  return { year, month, weeks };
}
