// Timezone wall-clock ↔ UTC helpers — pure, Intl-only (no tz-library dep).
// Shared by the quiet-hours evaluator and the visit propose-times slot
// generator so both convert participant-local wall-clock times to UTC instants
// the same DST-correct way.

export interface ZonedParts {
  readonly year: number;
  readonly month: number; // 1-12
  readonly day: number; // 1-31
  readonly hours: number; // 0-23
  readonly minutes: number; // 0-59
  readonly seconds: number; // 0-59
}

// Local wall-clock components of an instant, in the given IANA timezone.
export function getZonedParts(instant: Date, timeZone: string): ZonedParts {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const map: Record<string, string> = {};
  for (const part of dtf.formatToParts(instant)) {
    if (part.type !== "literal") map[part.type] = part.value;
  }
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hours: Number(map.hour),
    minutes: Number(map.minute),
    seconds: Number(map.second),
  };
}

// Offset (ms) of `timeZone` at `instant`: local-wall-clock-as-UTC minus the
// true UTC instant. Positive east of UTC, negative west (NYC ≈ -4/-5h).
export function tzOffsetMs(instant: Date, timeZone: string): number {
  const p = getZonedParts(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hours, p.minutes, p.seconds);
  return asUtc - instant.getTime();
}

// Convert a local wall-clock time (in `timeZone`) to the UTC instant. Two-pass
// to settle DST boundaries: the first offset guess can be wrong by an hour at a
// transition, so re-derive the offset at the candidate instant and reapply.
export function zonedWallClockToUtc(
  parts: { year: number; month: number; day: number; hours: number; minutes: number },
  timeZone: string,
): Date {
  const naiveUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hours,
    parts.minutes,
    0,
  );
  const firstOffset = tzOffsetMs(new Date(naiveUtc), timeZone);
  const firstGuess = naiveUtc - firstOffset;
  const secondOffset = tzOffsetMs(new Date(firstGuess), timeZone);
  return new Date(naiveUtc - secondOffset);
}
