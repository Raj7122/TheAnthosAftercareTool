import { describe, expect, it } from "vitest";

import { evaluateSession } from "../../src/session/timeout.js";
import type { SessionTimestamps } from "../../src/session/timeout.js";

const NOW = new Date("2026-05-20T12:00:00.000Z");
const MINUTE = 60_000;

// 30-minute idle window — the GAP-11 defensive default.
const IDLE_30M = { idleTimeoutSeconds: 1800 };

function session(over: Partial<SessionTimestamps>): SessionTimestamps {
  return {
    lastActivityAt: NOW,
    expiresAt: new Date(NOW.getTime() + 12 * 60 * MINUTE),
    revoked: false,
    ...over,
  };
}

describe("evaluateSession — idle timeout (GAP-11 / SEC-AUTH-5)", () => {
  it("is active when last activity is within the idle window", () => {
    const e = evaluateSession(
      session({ lastActivityAt: new Date(NOW.getTime() - 29 * MINUTE) }),
      NOW,
      IDLE_30M,
    );
    expect(e.status).toBe("active");
    expect(e.expiredAt).toBeNull();
  });

  it("is idle_expired once last activity is past the idle window", () => {
    const lastActivityAt = new Date(NOW.getTime() - 31 * MINUTE);
    const e = evaluateSession(session({ lastActivityAt }), NOW, IDLE_30M);
    expect(e.status).toBe("idle_expired");
    expect(e.expiredAt).toEqual(new Date(lastActivityAt.getTime() + 30 * MINUTE));
  });

  it("honors a non-default idle knob", () => {
    const lastActivityAt = new Date(NOW.getTime() - 61_000);
    expect(
      evaluateSession(session({ lastActivityAt }), NOW, { idleTimeoutSeconds: 60 }).status,
    ).toBe("idle_expired");
    expect(
      evaluateSession(session({ lastActivityAt }), NOW, { idleTimeoutSeconds: 120 }).status,
    ).toBe("active");
  });
});

describe("evaluateSession — absolute timeout (SEC-AUTH-11)", () => {
  it("is absolute_expired once expires_at has passed", () => {
    const expiresAt = new Date(NOW.getTime() - MINUTE);
    const e = evaluateSession(session({ expiresAt }), NOW, IDLE_30M);
    expect(e.status).toBe("absolute_expired");
    expect(e.expiredAt).toEqual(expiresAt);
  });

  it("the absolute cap outranks the idle clock when both have lapsed", () => {
    const e = evaluateSession(
      session({
        lastActivityAt: new Date(NOW.getTime() - 60 * MINUTE),
        expiresAt: new Date(NOW.getTime() - MINUTE),
      }),
      NOW,
      IDLE_30M,
    );
    expect(e.status).toBe("absolute_expired");
  });
});

describe("evaluateSession — revocation (SEC-AUTH-11)", () => {
  it("is revoked regardless of the timeout clocks", () => {
    const e = evaluateSession(
      session({
        revoked: true,
        lastActivityAt: NOW,
        expiresAt: new Date(NOW.getTime() + 12 * 60 * MINUTE),
      }),
      NOW,
      IDLE_30M,
    );
    expect(e.status).toBe("revoked");
    expect(e.expiredAt).toBeNull();
  });
});
