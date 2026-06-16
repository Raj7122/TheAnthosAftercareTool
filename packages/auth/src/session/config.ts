// Session configuration — the GAP-11 timeout knobs and the cookie policy.
//
// GAP-11 is OPEN: the 30-minute idle and 12-hour absolute timeouts are
// defensive defaults (SEC-AUTH-5 / SEC-AUTH-11). They are surfaced
// as env-driven knobs so Anthos compliance can retune them when GAP-11 closes
// — without a code change or redeploy logic.
//
// Cookie `SameSite` defaults to `Lax` (ticket AC + TRD SEC-AUTH-4). The API
// spec §11.2 wants `None` for the Salesforce-iframe end-state; that flip
// belongs to P1B-06, which also adds the Origin-header CSRF defense `None`
// requires — hence the knob.
//
// Pure, I/O-free, dependency-free apart from reading a passed-in env map.
import type { CookieAttributes, SameSite } from "./cookie.js";

export interface SessionConfig {
  readonly idleTimeoutSeconds: number;
  readonly absoluteTimeoutSeconds: number;
  readonly cookie: CookieAttributes;
}

export const DEFAULT_IDLE_TIMEOUT_SECONDS = 1800; // 30 min — GAP-11 defensive
export const DEFAULT_ABSOLUTE_TIMEOUT_SECONDS = 43200; // 12 h — SEC-AUTH-11
export const DEFAULT_COOKIE_SAMESITE: SameSite = "Lax"; // P1A-04 Decision 2

export const ENV_IDLE_TIMEOUT = "ANTHOS_SESSION_IDLE_TIMEOUT_SECONDS";
export const ENV_ABSOLUTE_TIMEOUT = "ANTHOS_SESSION_ABSOLUTE_TIMEOUT_SECONDS";
export const ENV_COOKIE_SAMESITE = "ANTHOS_SESSION_COOKIE_SAMESITE";
export const ENV_COOKIE_SECURE = "ANTHOS_SESSION_COOKIE_SECURE";
export const ENV_COOKIE_DOMAIN = "ANTHOS_SESSION_COOKIE_DOMAIN";

type Env = Record<string, string | undefined>;

// Bracketed read with a constant key. `env` is a plain string map and every
// key passed here is a module-level `ENV_*` constant — never user input — so
// the object-injection heuristic is a false positive, suppressed in one place.
function readEnv(env: Env, key: string): string | undefined {
  // eslint-disable-next-line security/detect-object-injection
  return env[key];
}

// Absent / empty → fallback. Present-but-malformed → throw: a garbage timeout
// is operator error and must fail loud, not silently revert to the default.
function parsePositiveInt(raw: string | undefined, key: string, fallback: number): number {
  if (raw === undefined || raw.trim().length === 0) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${key} must be a positive integer (seconds); got "${raw}".`);
  }
  return value;
}

function parseSameSite(raw: string | undefined, fallback: SameSite): SameSite {
  if (raw === undefined || raw.trim().length === 0) {
    return fallback;
  }
  const value = raw.trim();
  if (value === "Lax" || value === "Strict" || value === "None") {
    return value;
  }
  throw new Error(`${ENV_COOKIE_SAMESITE} must be Lax | Strict | None; got "${raw}".`);
}

function parseBool(raw: string | undefined, key: string, fallback: boolean): boolean {
  if (raw === undefined || raw.trim().length === 0) {
    return fallback;
  }
  const value = raw.trim().toLowerCase();
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new Error(`${key} must be true | false; got "${raw}".`);
}

// Resolve the effective session configuration from an environment map
// (defaults to `process.env`). `httpOnly` is always true and `path` is always
// "/" — neither is a knob: HttpOnly is a hard security invariant, and the
// cookie scopes to the whole app.
export function loadSessionConfig(env: Env = process.env): SessionConfig {
  const idleTimeoutSeconds = parsePositiveInt(
    readEnv(env, ENV_IDLE_TIMEOUT),
    ENV_IDLE_TIMEOUT,
    DEFAULT_IDLE_TIMEOUT_SECONDS,
  );
  const absoluteTimeoutSeconds = parsePositiveInt(
    readEnv(env, ENV_ABSOLUTE_TIMEOUT),
    ENV_ABSOLUTE_TIMEOUT,
    DEFAULT_ABSOLUTE_TIMEOUT_SECONDS,
  );
  if (idleTimeoutSeconds > absoluteTimeoutSeconds) {
    throw new Error(
      `${ENV_IDLE_TIMEOUT} (${idleTimeoutSeconds}) must not exceed ` +
        `${ENV_ABSOLUTE_TIMEOUT} (${absoluteTimeoutSeconds}) — the idle timeout would never fire.`,
    );
  }

  const sameSite = parseSameSite(readEnv(env, ENV_COOKIE_SAMESITE), DEFAULT_COOKIE_SAMESITE);
  const secure = parseBool(readEnv(env, ENV_COOKIE_SECURE), ENV_COOKIE_SECURE, true);
  const domain = readEnv(env, ENV_COOKIE_DOMAIN)?.trim();

  const cookie: CookieAttributes =
    domain === undefined || domain.length === 0
      ? { httpOnly: true, secure, sameSite, path: "/" }
      : { httpOnly: true, secure, sameSite, path: "/", domain };

  return { idleTimeoutSeconds, absoluteTimeoutSeconds, cookie };
}
