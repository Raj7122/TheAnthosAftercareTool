// Quiet-hours evaluation — the quiet-hours rule: no outbound communications
// 9 PM–8 AM in the *participant's* local timezone. Spec posture (PRD §, FS v1.12
// BR-47): the tool BLOCKS the send and offers to schedule it for the next
// allowed window; it does not silently defer.
//
// Pure function — no I/O, no clock of its own. The window bounds come from the
// active Configuration (`quietHoursStartLocal` / `quietHoursEndLocal`, e.g.
// "21:00" / "08:00") so calibration can tune them without a code change; the
// caller resolves the config and passes the window in. Timezone math uses
// `Intl.DateTimeFormat` only, so this stays unit-testable without a Next runtime
// and free of any tz-library dependency (no new third-party deps).
//
// [TBD] Participant timezone source: the spec leaves the canonical Salesforce
// field undefined (FS v1.12 E-14 edge case). Callers default to
// "America/New_York" (the org's locale) and MUST thread the real field through
// once Erik names it — see the SMS handler's call site.

import { getZonedParts, zonedWallClockToUtc } from "./zoned-time.js";

export interface QuietHoursWindow {
  // Local wall-clock start of quiet hours, "HH:mm" 24h (e.g. "21:00").
  readonly startLocalHHmm: string;
  // Local wall-clock end of quiet hours, "HH:mm" 24h (e.g. "08:00").
  readonly endLocalHHmm: string;
}

export interface EvaluateQuietHoursArgs {
  // The instant being evaluated — the request-scoped server clock.
  readonly now: Date;
  // IANA timezone of the participant (e.g. "America/New_York").
  readonly participantTimezone: string;
  readonly window: QuietHoursWindow;
}

export interface QuietHoursDecision {
  // True when `now` falls inside the quiet-hours window in participant-local time.
  readonly blocked: boolean;
  // When blocked: ISO-8601 UTC instant of the next window-open boundary (the
  // end-of-quiet-hours wall-clock time, in the participant tz). Null otherwise.
  readonly nextAllowedAtUtc: string | null;
}

interface HhMm {
  readonly hours: number;
  readonly minutes: number;
}

const HHMM_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

function parseHhMm(value: string): HhMm {
  const match = HHMM_RE.exec(value);
  if (match === null) {
    throw new RangeError(`Invalid HH:mm quiet-hours bound: "${value}"`);
  }
  // Capture groups are guaranteed numeric by the regex.
  return { hours: Number(match[1]), minutes: Number(match[2]) };
}

function toMinutes({ hours, minutes }: HhMm): number {
  return hours * 60 + minutes;
}

// Is `nowMin` inside [start, end)? When start > end the window wraps midnight
// (the 21:00→08:00 case): inside means at/after start OR before end.
function isInsideWindow(nowMin: number, startMin: number, endMin: number): boolean {
  if (startMin === endMin) return false; // empty window
  if (startMin < endMin) return nowMin >= startMin && nowMin < endMin;
  return nowMin >= startMin || nowMin < endMin;
}

// Evaluates the quiet-hours rule for `now` in the participant's local timezone.
// When blocked, computes the next window-open instant (the end-of-quiet-hours
// wall-clock time today if still ahead in local time, else tomorrow).
export function evaluateQuietHours(args: EvaluateQuietHoursArgs): QuietHoursDecision {
  const start = parseHhMm(args.window.startLocalHHmm);
  const end = parseHhMm(args.window.endLocalHHmm);
  const startMin = toMinutes(start);
  const endMin = toMinutes(end);

  const local = getZonedParts(args.now, args.participantTimezone);
  const nowMin = local.hours * 60 + local.minutes;

  if (!isInsideWindow(nowMin, startMin, endMin)) {
    return { blocked: false, nextAllowedAtUtc: null };
  }

  // Blocked — the next allowed instant is the end-of-quiet-hours wall clock.
  // If the local time is already past `end` today (only possible in the
  // wrap-around branch, e.g. 23:30 with end 08:00), roll to tomorrow.
  const rollToTomorrow = nowMin >= endMin;
  const endDayUtc = rollToTomorrow
    ? Date.UTC(local.year, local.month - 1, local.day + 1)
    : Date.UTC(local.year, local.month - 1, local.day);
  const endDay = new Date(endDayUtc);
  const nextAllowed = zonedWallClockToUtc(
    {
      year: endDay.getUTCFullYear(),
      month: endDay.getUTCMonth() + 1,
      day: endDay.getUTCDate(),
      hours: end.hours,
      minutes: end.minutes,
    },
    args.participantTimezone,
  );

  return { blocked: true, nextAllowedAtUtc: nextAllowed.toISOString() };
}
