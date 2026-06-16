// P1H-11 (demo) — quiet-hours check for the SMS compose surface.
//
// Quiet-hours rule: no outbound communications 9 PM–8 AM in the
// PARTICIPANT's local timezone. The real F-09 SMS path enforces this
// server-side in the notifications layer against the participant timezone and
// the `packages/domain` config window (default 21:00:00–08:00:00).
//
// This demo helper is a SOFT, non-blocking surface affordance only. It
// approximates with the browser-local clock because the participant timezone
// is not threaded to the compose sheet today; the warning communicates the
// policy without claiming to enforce it. When F-09 lands it owns the
// authoritative check and this helper is retired.

export const QUIET_HOURS_START_HOUR = 21 as const; // 9 PM
export const QUIET_HOURS_END_HOUR = 8 as const; // 8 AM

// True when `now`'s local hour falls in the [21:00, 08:00) overnight window.
// The window wraps midnight, so the test is "at or after 9 PM, OR before
// 8 AM".
export function isInQuietHours(now: Date): boolean {
  const hour = now.getHours();
  return hour >= QUIET_HOURS_START_HOUR || hour < QUIET_HOURS_END_HOUR;
}

export const QUIET_HOURS_WARNING =
  "Quiet hours (9 PM–8 AM): outbound messages are normally paused. This demo will still send.";
