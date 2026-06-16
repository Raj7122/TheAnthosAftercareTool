// Session primitives — opaque-token minting/hashing, cookie serialization,
// timeout configuration, and pure timeout evaluation. I/O-free and free of
// `@anthos/persistence` / `@anthos/audit` imports so `@anthos/auth` stays at
// the bottom of the dependency graph (the HTTP middleware that wires these to
// a store and the audit writer lives in `@anthos/api`).
export { hashToken, hashUserAgent, mintToken, TOKEN_HASH_LENGTH } from "./token.js";

export {
  clearSessionCookie,
  parseSessionCookie,
  serializeSessionCookie,
  SESSION_COOKIE_NAME,
} from "./cookie.js";
export type { CookieAttributes, SameSite } from "./cookie.js";

export {
  DEFAULT_ABSOLUTE_TIMEOUT_SECONDS,
  DEFAULT_COOKIE_SAMESITE,
  DEFAULT_IDLE_TIMEOUT_SECONDS,
  ENV_ABSOLUTE_TIMEOUT,
  ENV_COOKIE_DOMAIN,
  ENV_COOKIE_SAMESITE,
  ENV_COOKIE_SECURE,
  ENV_IDLE_TIMEOUT,
  loadSessionConfig,
} from "./config.js";
export type { SessionConfig } from "./config.js";

export { evaluateSession } from "./timeout.js";
export type { SessionEvaluation, SessionStatus, SessionTimestamps } from "./timeout.js";
