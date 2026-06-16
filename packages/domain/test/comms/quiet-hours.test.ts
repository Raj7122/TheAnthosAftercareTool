import { describe, expect, it } from "vitest";

import { evaluateQuietHours } from "../../src/comms/quiet-hours.js";
import type { QuietHoursWindow } from "../../src/comms/quiet-hours.js";

// Immutable #4 window: 9 PM–8 AM participant-local.
const WINDOW: QuietHoursWindow = { startLocalHHmm: "21:00", endLocalHHmm: "08:00" };
const NYC = "America/New_York";

describe("evaluateQuietHours", () => {
  it("does not block mid-morning local time", () => {
    // 2026-05-22T15:30Z → 11:30 EDT (outside window).
    const d = evaluateQuietHours({
      now: new Date("2026-05-22T15:30:00Z"),
      participantTimezone: NYC,
      window: WINDOW,
    });
    expect(d.blocked).toBe(false);
    expect(d.nextAllowedAtUtc).toBeNull();
  });

  it("blocks late evening local time and rolls next-allowed to 08:00 next day", () => {
    // 2026-05-22T03:00Z → 23:00 EDT on 2026-05-21 (inside window).
    const d = evaluateQuietHours({
      now: new Date("2026-05-22T03:00:00Z"),
      participantTimezone: NYC,
      window: WINDOW,
    });
    expect(d.blocked).toBe(true);
    // 08:00 EDT on 2026-05-22 == 12:00:00Z.
    expect(d.nextAllowedAtUtc).toBe("2026-05-22T12:00:00.000Z");
  });

  it("blocks pre-dawn local time and next-allowed is 08:00 same day", () => {
    // 2026-05-22T10:00Z → 06:00 EDT on 2026-05-22 (inside window, before 08:00).
    const d = evaluateQuietHours({
      now: new Date("2026-05-22T10:00:00Z"),
      participantTimezone: NYC,
      window: WINDOW,
    });
    expect(d.blocked).toBe(true);
    expect(d.nextAllowedAtUtc).toBe("2026-05-22T12:00:00.000Z");
  });

  it("does not block exactly at the window-open boundary (08:00 local)", () => {
    // 2026-05-22T12:00Z → 08:00 EDT (window end is exclusive of being inside).
    const d = evaluateQuietHours({
      now: new Date("2026-05-22T12:00:00Z"),
      participantTimezone: NYC,
      window: WINDOW,
    });
    expect(d.blocked).toBe(false);
  });

  it("blocks exactly at the window-start boundary (21:00 local)", () => {
    // 2026-05-23T01:00Z → 21:00 EDT on 2026-05-22 (window start is inclusive).
    const d = evaluateQuietHours({
      now: new Date("2026-05-23T01:00:00Z"),
      participantTimezone: NYC,
      window: WINDOW,
    });
    expect(d.blocked).toBe(true);
    // next 08:00 EDT is 2026-05-23T12:00Z.
    expect(d.nextAllowedAtUtc).toBe("2026-05-23T12:00:00.000Z");
  });

  it("respects a different timezone for the same UTC instant", () => {
    // 2026-05-22T03:00Z → 20:00 PDT (America/Los_Angeles) — outside window;
    // same instant is 23:00 EDT in NYC — inside. Proves participant-TZ binding.
    const la = evaluateQuietHours({
      now: new Date("2026-05-22T03:00:00Z"),
      participantTimezone: "America/Los_Angeles",
      window: WINDOW,
    });
    expect(la.blocked).toBe(false);
  });

  it("throws on a malformed window bound", () => {
    expect(() =>
      evaluateQuietHours({
        now: new Date("2026-05-22T15:30:00Z"),
        participantTimezone: NYC,
        window: { startLocalHHmm: "9pm", endLocalHHmm: "08:00" },
      }),
    ).toThrow(/Invalid HH:mm/);
  });
});
