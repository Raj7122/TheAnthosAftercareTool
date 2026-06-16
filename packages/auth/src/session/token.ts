// Opaque session-token primitives (ADR-03 / SEC-AUTH-8). The token is a
// 256-bit random value — never a JWT: field tablets carry high physical-
// compromise risk, and opaque tokens give O(1) instant revocation
// (SEC-AUTH-9/10/11). The cookie carries the plaintext token; the DB stores
// only `hashToken()` of it, so a DB dump never yields a live token.
//
// Pure, I/O-free, dependency-free — `@anthos/auth` must not import
// `@anthos/persistence` or `@anthos/audit` (would cycle).
import { createHash, randomBytes } from "node:crypto";

// 256 bits of entropy — 32 random bytes.
const TOKEN_BYTES = 32;

// `hashToken` always returns lowercase hex of this length (SHA-256). The
// `sessions.token_hash` column is `varchar(64)`.
export const TOKEN_HASH_LENGTH = 64;

// Mint a fresh opaque session token: 32 cryptographically-random bytes,
// base64url-encoded (43 chars, URL- and cookie-safe, no padding). The raw
// value is delivered only inside the HttpOnly `anthos_session` cookie.
export function mintToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

// SHA-256 of the token as 64-char lowercase hex. This is the value persisted
// in `sessions.token_hash` and the key the middleware looks sessions up by.
// Deterministic: the same token always hashes to the same value, so the
// inbound cookie resolves to its row by indexed equality — no plaintext token
// is ever compared in application code.
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

// SHA-256 of a request's `User-Agent` header as 64-char lowercase hex, for the
// `sessions.user_agent_hash` column. The raw UA string is mildly fingerprinting
// (a soft PII signal) — `/auth/callback` stores only the hash, so a session row
// retains a stable device discriminator without persisting the raw header.
// An absent / empty header hashes the empty string deterministically.
export function hashUserAgent(userAgent: string | null | undefined): string {
  return createHash("sha256").update(userAgent ?? "", "utf8").digest("hex");
}
