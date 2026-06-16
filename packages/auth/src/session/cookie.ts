// `anthos_session` cookie serialization + parsing (ADR-03 / SEC-AUTH-4).
// First-party, scoped to the tool's own origin. `HttpOnly` is non-negotiable
// — the raw token must never be readable by JavaScript — so it is not a
// configurable attribute. `Secure` and `SameSite` are policy knobs carried on
// `CookieAttributes` (see config.ts).
//
// Pure, I/O-free, dependency-free.

export const SESSION_COOKIE_NAME = "anthos_session";

export type SameSite = "Lax" | "Strict" | "None";

// The static cookie policy. `maxAge` is dynamic (it tracks the idle timeout)
// and is passed per-call to `serializeSessionCookie`, not stored here.
export interface CookieAttributes {
  readonly httpOnly: boolean;
  readonly secure: boolean;
  readonly sameSite: SameSite;
  readonly path: string;
  // Omitted entirely for a host-only cookie (scoped to exactly the origin
  // host — the "tool's own origin" posture). Set only when an env needs a
  // wider scope.
  readonly domain?: string;
}

function baseAttributes(attrs: CookieAttributes): string[] {
  const parts = [`Path=${attrs.path}`, `SameSite=${attrs.sameSite}`];
  if (attrs.domain !== undefined) {
    parts.push(`Domain=${attrs.domain}`);
  }
  if (attrs.httpOnly) {
    parts.push("HttpOnly");
  }
  if (attrs.secure) {
    parts.push("Secure");
  }
  return parts;
}

// Build the `Set-Cookie` value that issues a session. `maxAgeSeconds` is the
// cookie's Max-Age — it tracks the idle timeout (API §7.2.2).
export function serializeSessionCookie(
  token: string,
  attrs: CookieAttributes,
  maxAgeSeconds: number,
): string {
  return [
    `${SESSION_COOKIE_NAME}=${token}`,
    ...baseAttributes(attrs),
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
  ].join("; ");
}

// Build the `Set-Cookie` value that clears the session cookie — `Max-Age=0`
// expires it immediately. Used by logout / revoke.
export function clearSessionCookie(attrs: CookieAttributes): string {
  return [`${SESSION_COOKIE_NAME}=`, ...baseAttributes(attrs), "Max-Age=0"].join("; ");
}

// Read the raw `anthos_session` token from an inbound `Cookie` header.
// Returns null when the header is absent or carries no session cookie.
export function parseSessionCookie(cookieHeader: string | null | undefined): string | null {
  if (cookieHeader === null || cookieHeader === undefined || cookieHeader.length === 0) {
    return null;
  }
  for (const pair of cookieHeader.split(";")) {
    const eq = pair.indexOf("=");
    if (eq === -1) {
      continue;
    }
    if (pair.slice(0, eq).trim() === SESSION_COOKIE_NAME) {
      const value = pair.slice(eq + 1).trim();
      return value.length > 0 ? value : null;
    }
  }
  return null;
}
