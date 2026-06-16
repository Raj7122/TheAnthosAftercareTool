// OAuth `state` parameter — the CSRF defense for the authorize → callback
// redirect chain (RFC 6749 §10.12). Independent of API §8.6's Origin-header
// defense, which guards post-session mutation endpoints.
//
// Pure, I/O-free — `node:crypto` only. Kept separate from `session/token.ts` so
// the two concerns (CSRF state vs. opaque session token) evolve independently.
import { randomBytes } from "node:crypto";

// 256 bits of CSPRNG entropy — unguessable.
export const OAUTH_STATE_BYTES = 32;

// Mint a fresh `state`: 32 random bytes, base64url-encoded (43 chars, URL-safe,
// no padding). Persisted (encrypted) in the `anthos_oauth_state` cookie and
// sent as the `state` query param; the callback (P1B-02) requires the two to
// match.
export function generateOAuthState(): string {
  return randomBytes(OAUTH_STATE_BYTES).toString("base64url");
}
