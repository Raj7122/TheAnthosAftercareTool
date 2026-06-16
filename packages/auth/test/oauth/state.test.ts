import { describe, expect, it } from "vitest";

import { generateOAuthState, OAUTH_STATE_BYTES } from "../../src/oauth/state.js";

describe("OAuth state — generateOAuthState (CSRF, RFC 6749 §10.12)", () => {
  it("decodes to 256 bits (32 bytes) of entropy", () => {
    expect(Buffer.from(generateOAuthState(), "base64url")).toHaveLength(OAUTH_STATE_BYTES);
  });

  it("is URL-safe base64url and not a JWT — no '+', '/', '=', or '.'", () => {
    const state = generateOAuthState();
    expect(state).toMatch(/^[A-Za-z0-9\-_]+$/);
    expect(state).not.toContain(".");
  });

  it("is unguessable — 100 successive mints are all distinct", () => {
    const states = new Set(Array.from({ length: 100 }, () => generateOAuthState()));
    expect(states.size).toBe(100);
  });
});
