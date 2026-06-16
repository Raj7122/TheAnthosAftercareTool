import { describe, expect, it } from "vitest";

import { isInQuietHours } from "../../app/_lib/comms/quiet-hours";

// Build a local-time Date at a given hour so the test exercises the same
// `getHours()` path the helper uses.
function atHour(hour: number): Date {
  return new Date(2026, 4, 29, hour, 0, 0);
}

describe("isInQuietHours", () => {
  it("is quiet at and after 9 PM", () => {
    expect(isInQuietHours(atHour(21))).toBe(true);
    expect(isInQuietHours(atHour(23))).toBe(true);
  });

  it("is quiet before 8 AM", () => {
    expect(isInQuietHours(atHour(0))).toBe(true);
    expect(isInQuietHours(atHour(7))).toBe(true);
  });

  it("is not quiet during the day", () => {
    expect(isInQuietHours(atHour(8))).toBe(false);
    expect(isInQuietHours(atHour(12))).toBe(false);
    expect(isInQuietHours(atHour(20))).toBe(false);
  });
});
