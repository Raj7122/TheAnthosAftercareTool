import { describe, expect, it } from "vitest";

import {
  DEFAULT_ABSOLUTE_TIMEOUT_SECONDS,
  DEFAULT_IDLE_TIMEOUT_SECONDS,
  ENV_ABSOLUTE_TIMEOUT,
  ENV_COOKIE_DOMAIN,
  ENV_COOKIE_SAMESITE,
  ENV_COOKIE_SECURE,
  ENV_IDLE_TIMEOUT,
  loadSessionConfig,
} from "../../src/session/config.js";

describe("loadSessionConfig — defaults (GAP-11 defensive)", () => {
  it("falls back to 30-min idle / 12-h absolute on an empty env", () => {
    const config = loadSessionConfig({});
    expect(config.idleTimeoutSeconds).toBe(DEFAULT_IDLE_TIMEOUT_SECONDS);
    expect(config.absoluteTimeoutSeconds).toBe(DEFAULT_ABSOLUTE_TIMEOUT_SECONDS);
    expect(config.idleTimeoutSeconds).toBe(1800);
    expect(config.absoluteTimeoutSeconds).toBe(43200);
  });

  it("defaults the cookie to HttpOnly + Secure + SameSite=Lax, host-only", () => {
    const { cookie } = loadSessionConfig({});
    expect(cookie).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      path: "/",
    });
  });
});

describe("loadSessionConfig — env knobs", () => {
  it("applies the timeout overrides", () => {
    const config = loadSessionConfig({
      [ENV_IDLE_TIMEOUT]: "900",
      [ENV_ABSOLUTE_TIMEOUT]: "7200",
    });
    expect(config.idleTimeoutSeconds).toBe(900);
    expect(config.absoluteTimeoutSeconds).toBe(7200);
  });

  it("applies the cookie knobs (SameSite=None for the P1B-06 iframe flip)", () => {
    const { cookie } = loadSessionConfig({
      [ENV_COOKIE_SAMESITE]: "None",
      [ENV_COOKIE_SECURE]: "false",
      [ENV_COOKIE_DOMAIN]: "aftercare.test",
    });
    expect(cookie.sameSite).toBe("None");
    expect(cookie.secure).toBe(false);
    expect(cookie.domain).toBe("aftercare.test");
  });

  it("keeps HttpOnly true — it is not a knob", () => {
    expect(loadSessionConfig({ [ENV_COOKIE_SECURE]: "false" }).cookie.httpOnly).toBe(true);
  });
});

describe("loadSessionConfig — malformed values fail loud", () => {
  it("throws on a non-integer idle timeout", () => {
    expect(() => loadSessionConfig({ [ENV_IDLE_TIMEOUT]: "abc" })).toThrow();
  });

  it("throws on a non-positive timeout", () => {
    expect(() => loadSessionConfig({ [ENV_ABSOLUTE_TIMEOUT]: "0" })).toThrow();
  });

  it("throws on an unrecognized SameSite value", () => {
    expect(() => loadSessionConfig({ [ENV_COOKIE_SAMESITE]: "Loose" })).toThrow();
  });

  it("throws on a non-boolean secure value", () => {
    expect(() => loadSessionConfig({ [ENV_COOKIE_SECURE]: "yes" })).toThrow();
  });

  it("throws when the idle timeout exceeds the absolute timeout", () => {
    expect(() =>
      loadSessionConfig({
        [ENV_IDLE_TIMEOUT]: "50000",
        [ENV_ABSOLUTE_TIMEOUT]: "43200",
      }),
    ).toThrow();
  });
});
