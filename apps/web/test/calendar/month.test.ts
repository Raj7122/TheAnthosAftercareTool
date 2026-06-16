import { describe, expect, it } from "vitest";

import {
  addMonths,
  buildMonthMatrix,
  isoToYmd,
  monthLabel,
  monthOfYmd,
  ymdKeyUtc,
} from "../../app/_lib/calendar/month";

describe("ymdKeyUtc / isoToYmd", () => {
  it("formats a UTC date as YYYY-MM-DD", () => {
    expect(ymdKeyUtc(new Date(Date.UTC(2026, 4, 5)))).toBe("2026-05-05");
  });

  it("normalizes a plain ISO date", () => {
    expect(isoToYmd("2026-05-29")).toBe("2026-05-29");
  });

  it("normalizes an ISO timestamp to its UTC calendar day", () => {
    expect(isoToYmd("2026-05-29T14:30:00Z")).toBe("2026-05-29");
  });

  it("returns null for null/empty/garbage", () => {
    expect(isoToYmd(null)).toBeNull();
    expect(isoToYmd("")).toBeNull();
    expect(isoToYmd("not-a-date")).toBeNull();
  });
});

describe("addMonths", () => {
  it("wraps backward across a year boundary", () => {
    expect(addMonths(2026, 0, -1)).toEqual({ year: 2025, month: 11 });
  });
  it("wraps forward across a year boundary", () => {
    expect(addMonths(2026, 11, 1)).toEqual({ year: 2027, month: 0 });
  });
  it("handles multi-month deltas", () => {
    expect(addMonths(2026, 4, 10)).toEqual({ year: 2027, month: 2 });
  });
});

describe("monthOfYmd / monthLabel", () => {
  it("extracts year/month (0-based)", () => {
    expect(monthOfYmd("2026-06-15")).toEqual({ year: 2026, month: 5 });
  });
  it("returns null for null", () => {
    expect(monthOfYmd(null)).toBeNull();
  });
  it("labels a month", () => {
    expect(monthLabel(2026, 4)).toBe("May 2026");
  });
});

describe("buildMonthMatrix", () => {
  const m = buildMonthMatrix(2026, 4, "2026-05-29"); // May 2026

  it("is a 6×7 grid", () => {
    expect(m.weeks).toHaveLength(6);
    for (const week of m.weeks) expect(week).toHaveLength(7);
  });

  it("contains all 31 May days as in-month cells", () => {
    const inMonth = m.weeks.flat().filter((c) => c.inMonth);
    expect(inMonth).toHaveLength(31);
    expect(inMonth[0]?.ymd).toBe("2026-05-01");
    expect(inMonth[30]?.ymd).toBe("2026-05-31");
  });

  it("starts the grid on a Sunday (leading days from April are out-of-month)", () => {
    const first = m.weeks[0]?.[0];
    // May 1 2026 is a Friday, so the grid starts Sun Apr 26.
    expect(first?.ymd).toBe("2026-04-26");
    expect(first?.inMonth).toBe(false);
  });

  it("flags today", () => {
    const today = m.weeks.flat().filter((c) => c.isToday);
    expect(today).toHaveLength(1);
    expect(today[0]?.ymd).toBe("2026-05-29");
  });

  it("handles February in a non-leap year (2026)", () => {
    const feb = buildMonthMatrix(2026, 1, "2026-02-15");
    expect(feb.weeks.flat().filter((c) => c.inMonth)).toHaveLength(28);
  });

  it("handles February in a leap year (2028)", () => {
    const feb = buildMonthMatrix(2028, 1, "2028-02-15");
    expect(feb.weeks.flat().filter((c) => c.inMonth)).toHaveLength(29);
  });
});
