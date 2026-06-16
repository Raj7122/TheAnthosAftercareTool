import { describe, expect, it } from "vitest";

import {
  deriveStaleState,
  formatAsOfTime,
  STALE_DISPLAY_THRESHOLD_MS,
} from "../../app/caseload/_lib/stale";

describe("deriveStaleState", () => {
  const fetchedAt = new Date("2026-05-22T14:30:00Z");

  it("subtracts cacheAgeSeconds from fetchedAt to compute asOf", () => {
    const result = deriveStaleState({
      cacheAgeSeconds: 120,
      fetchedAt,
      now: fetchedAt,
    });
    expect(result.asOf.toISOString()).toBe("2026-05-22T14:28:00.000Z");
  });

  it("treats freshly-hydrated data (cacheAgeSeconds === 0) as never stale", () => {
    const result = deriveStaleState({
      cacheAgeSeconds: 0,
      fetchedAt,
      now: new Date(fetchedAt.getTime() + STALE_DISPLAY_THRESHOLD_MS + 60_000),
    });
    expect(result.isStale).toBe(false);
  });

  it("does not flag stale within the threshold window", () => {
    const result = deriveStaleState({
      cacheAgeSeconds: 30,
      fetchedAt,
      now: new Date(fetchedAt.getTime() + STALE_DISPLAY_THRESHOLD_MS - 1_000),
    });
    expect(result.isStale).toBe(false);
  });

  it("flags stale once display age exceeds the threshold for cache-served data", () => {
    const result = deriveStaleState({
      cacheAgeSeconds: 30,
      fetchedAt,
      now: new Date(fetchedAt.getTime() + STALE_DISPLAY_THRESHOLD_MS + 1_000),
    });
    expect(result.isStale).toBe(true);
  });

  it("clamps negative cacheAgeSeconds at the boundary (defensive)", () => {
    const result = deriveStaleState({
      cacheAgeSeconds: -5,
      fetchedAt,
      now: fetchedAt,
    });
    expect(result.asOf.toISOString()).toBe(fetchedAt.toISOString());
    expect(result.isStale).toBe(false);
  });
});

describe("formatAsOfTime", () => {
  it("renders zero-padded HH:MM in America/New_York during EDT (UTC-4)", () => {
    // 13:05 UTC on a summer date → 09:05 EDT.
    expect(formatAsOfTime(new Date("2026-06-03T13:05:00Z"))).toBe("09:05 ET");
  });

  it("handles the ET midnight boundary during EST (UTC-5)", () => {
    // 05:00 UTC on a winter date → 00:00 EST (also exercises DST handling).
    expect(formatAsOfTime(new Date("2026-01-15T05:00:00Z"))).toBe("00:00 ET");
  });
});
