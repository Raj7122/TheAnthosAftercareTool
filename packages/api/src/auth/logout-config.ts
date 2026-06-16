// Logout configuration — the env-driven knobs for POST /api/v1/auth/logout
// (E-04). Unlike callback (E-02) and refresh (E-03), this endpoint touches no
// Salesforce credential and decrypts nothing, so it needs ONLY the
// `anthos_session` cookie policy: the `Set-Cookie` that clears the cookie must
// carry the SAME Domain / Path / Secure / SameSite / HttpOnly attributes the
// callback issued it with, or the browser will not overwrite it.
//
// `resolveSessionCookieAttributes` is reused verbatim from the callback/refresh
// loaders so the three endpoints cannot drift on cookie attributes.
//
// Fail-loud on a malformed value, mirroring `refresh-config.ts`: operator error
// must not silently degrade an auth endpoint.

import { loadSessionConfig } from "@anthos/auth";
import type { CookieAttributes } from "@anthos/auth";

import { resolveSessionCookieAttributes } from "./callback-config.js";

export interface AuthLogoutConfig {
  // Attributes for the cleared `anthos_session` Set-Cookie — identical to the
  // ones the callback (E-02) issued the cookie with.
  readonly sessionCookie: CookieAttributes;
}

type Env = Record<string, string | undefined>;

// Resolve the effective logout config from an env map (defaults to
// `process.env`). Throws — naming the offending env var, never its value —
// when an `ANTHOS_SESSION_*` var is malformed (via `loadSessionConfig`).
export function loadAuthLogoutConfig(env: Env = process.env): AuthLogoutConfig {
  const session = loadSessionConfig(env);
  return { sessionCookie: resolveSessionCookieAttributes(session, env) };
}
