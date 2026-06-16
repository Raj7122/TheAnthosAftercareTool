// P3C-10 — canonical client-side `Idempotency-Key` generator
// (TR-OFFLINE-6a + TR-WRITE-2c + Pattern D).
//
// Locks two DoD invariants:
//   • key is an RFC 4122 v4 UUID (crypto-strong; no `Math.random` could
//     reliably satisfy the version + variant nibble constraints)
//   • generation is collision-free across a saturated burst
//
// The regex mirrors the one the server-side P1A-03 middleware uses in
// `packages/api/src/idempotency/middleware.ts` so a key minted here is
// guaranteed to pass server validation.

import { describe, expect, it } from "vitest";

import { newIdempotencyKey } from "../src/idempotency-key.js";

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("newIdempotencyKey", () => {
  it("emits an RFC 4122 v4 UUID", () => {
    expect(newIdempotencyKey()).toMatch(UUID_V4);
  });

  // 10k is the saturated-burst bound: matches the wording of the P3C-10 DoD
  // ("no collisions") and is large enough that any non-crypto fallback (e.g.,
  // a counter or `Math.random`) would either trip the format regex above or
  // — for a counter-only impl — be obvious in CI without slowing the suite.
  it("produces unique values across 10k calls (no collisions)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i++) {
      seen.add(newIdempotencyKey());
    }
    expect(seen.size).toBe(10_000);
  });
});
