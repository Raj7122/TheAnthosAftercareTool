// Client-side staleness derivation for the caseload SPA.
//
// E-06 (API v1.3 §7.3.1) returns `cacheAgeSeconds` but no `freshness`
// discriminator — the server-side `"fresh" | "stale" | "miss"` state is
// internal to the `caseload_cache` repository. The handler always responds
// with either a fresh cached body (`cacheAgeSeconds <= freshness window`)
// or a freshly-hydrated body (`cacheAgeSeconds === 0`).
//
// The "stale-cache indicator" the SPA shows is therefore a *display* concept:
// "I last fetched at HH:MM; the underlying data was N seconds older still."
// We declare the display stale when the user has been looking at the same
// fetched data for longer than `STALE_DISPLAY_THRESHOLD_MS`, AND that data
// was served from cache (not freshly hydrated). The bar is intentionally
// subtle — the ticket calls out "don't make it alarming during the demo."

export const STALE_DISPLAY_THRESHOLD_MS = 5 * 60 * 1000;

export interface StaleInput {
  readonly cacheAgeSeconds: number;
  readonly fetchedAt: Date;
  readonly now: Date;
}

export interface StaleState {
  // The instant the underlying data represents — used to render "HH:MM ET".
  readonly asOf: Date;
  // True when the display has been showing cache-served data for longer than
  // the stale threshold. False for freshly-hydrated data regardless of age.
  readonly isStale: boolean;
}

export function deriveStaleState(input: StaleInput): StaleState {
  const cacheAgeMs = Math.max(0, input.cacheAgeSeconds) * 1000;
  const asOf = new Date(input.fetchedAt.getTime() - cacheAgeMs);
  const displayAgeMs = input.now.getTime() - input.fetchedAt.getTime();
  const servedFromCache = input.cacheAgeSeconds > 0;
  return {
    asOf,
    isStale: servedFromCache && displayAgeMs > STALE_DISPLAY_THRESHOLD_MS,
  };
}

// 24h "HH:MM ET" formatter in America/New_York (Anthos' operating timezone, so
// specialists read the clock as their local wall time). The timeZone is pinned
// explicitly, which also keeps the SSR pass (Vercel function clock, UTC) and the
// client hydration (browser local clock) byte-identical — the bare `getHours()`
// it replaced produced a React #418 hydration mismatch. ET covers EST/EDT; the
// offset is resolved per-instant by the runtime ICU data, so DST is automatic.
const ET_TIME_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export function formatAsOfTime(asOf: Date): string {
  return `${ET_TIME_FORMAT.format(asOf)} ET`;
}
