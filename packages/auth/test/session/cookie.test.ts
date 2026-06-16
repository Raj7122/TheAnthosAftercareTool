import { describe, expect, it } from "vitest";

import type { CookieAttributes } from "../../src/session/cookie.js";
import {
  clearSessionCookie,
  parseSessionCookie,
  serializeSessionCookie,
  SESSION_COOKIE_NAME,
} from "../../src/session/cookie.js";

// The ticket-default cookie policy: HttpOnly + Secure + SameSite=Lax, host-only.
const LAX_ATTRS: CookieAttributes = {
  httpOnly: true,
  secure: true,
  sameSite: "Lax",
  path: "/",
};

describe("serializeSessionCookie (SEC-AUTH-4)", () => {
  it("emits anthos_session with HttpOnly + Secure + SameSite=Lax + Path", () => {
    const cookie = serializeSessionCookie("tok-abc", LAX_ATTRS, 1800);
    expect(cookie).toContain(`${SESSION_COOKIE_NAME}=tok-abc`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Max-Age=1800");
  });

  it("omits Secure when the knob is off (local dev over http)", () => {
    const cookie = serializeSessionCookie("t", { ...LAX_ATTRS, secure: false }, 60);
    expect(cookie).not.toContain("Secure");
  });

  it("honors the SameSite knob — None for the P1B-06 iframe end-state", () => {
    expect(serializeSessionCookie("t", { ...LAX_ATTRS, sameSite: "None" }, 60)).toContain(
      "SameSite=None",
    );
  });

  it("emits Domain only when set — host-only otherwise", () => {
    expect(serializeSessionCookie("t", LAX_ATTRS, 60)).not.toContain("Domain=");
    expect(
      serializeSessionCookie("t", { ...LAX_ATTRS, domain: "aftercare.test" }, 60),
    ).toContain("Domain=aftercare.test");
  });

  it("floors Max-Age at 0 and to an integer", () => {
    expect(serializeSessionCookie("t", LAX_ATTRS, -5)).toContain("Max-Age=0");
    expect(serializeSessionCookie("t", LAX_ATTRS, 12.9)).toContain("Max-Age=12");
  });
});

describe("clearSessionCookie", () => {
  it("expires the cookie immediately with an empty value", () => {
    const cookie = clearSessionCookie(LAX_ATTRS);
    expect(cookie).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(cookie).toContain("Max-Age=0");
    expect(cookie).toContain("HttpOnly");
  });
});

describe("parseSessionCookie", () => {
  it("round-trips the token out of a Cookie header", () => {
    const token = "abc123_-XYZ";
    expect(parseSessionCookie(`${SESSION_COOKIE_NAME}=${token}`)).toBe(token);
  });

  it("finds anthos_session among other cookies", () => {
    expect(
      parseSessionCookie(`theme=dark; ${SESSION_COOKIE_NAME}=tok-xyz; locale=en`),
    ).toBe("tok-xyz");
  });

  it("returns null when the header is absent", () => {
    expect(parseSessionCookie(null)).toBeNull();
    expect(parseSessionCookie(undefined)).toBeNull();
    expect(parseSessionCookie("")).toBeNull();
  });

  it("returns null when no session cookie is present", () => {
    expect(parseSessionCookie("theme=dark; locale=en")).toBeNull();
  });

  it("returns null for a present-but-empty session cookie", () => {
    expect(parseSessionCookie(`${SESSION_COOKIE_NAME}=`)).toBeNull();
  });
});
