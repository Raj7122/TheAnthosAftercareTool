// PKCE (RFC 7636) primitives for the Salesforce Authorization Code flow.
// `generatePkcePair` mints a fresh `code_verifier` and its S256 `code_challenge`
// for GET /api/v1/auth/login (E-01); `deriveCodeChallenge` lets the callback
// (P1B-02) recompute the challenge from a verifier read back out of the
// encrypted cookie.
//
// Pure, I/O-free — `node:crypto` only.
import { createHash, randomBytes } from "node:crypto";

// RFC 7636 §4.1: `code_verifier` is 43–128 chars from the unreserved set
// (ALPHA / DIGIT / "-" / "." / "_" / "~").
export const PKCE_VERIFIER_MIN_LENGTH = 43;
export const PKCE_VERIFIER_MAX_LENGTH = 128;

// The only challenge method this flow uses — the `plain` method is forbidden
// (Immutable #3 / SEC-AUTH-1).
export const PKCE_CHALLENGE_METHOD = "S256" as const;

// 64 random bytes → 86 base64url chars: comfortably inside the 43–128 bound and
// entirely within the unreserved set (base64url is [A-Za-z0-9-_], no "+"/"/").
const VERIFIER_BYTES = 64;

// The base64url alphabet — the subset of RFC 7636's unreserved set this module
// emits. (RFC 7636 also permits "." and "~"; we never generate them.)
const VERIFIER_PATTERN = /^[A-Za-z0-9\-_]+$/;

export interface PkcePair {
  readonly codeVerifier: string;
  readonly codeChallenge: string;
}

// A fresh CSPRNG `code_verifier` and its S256 challenge. Throws if the
// generated verifier somehow falls outside the RFC 7636 bounds — a defensive
// invariant, not an expected path.
export function generatePkcePair(): PkcePair {
  const codeVerifier = randomBytes(VERIFIER_BYTES).toString("base64url");
  if (!isValidCodeVerifier(codeVerifier)) {
    throw new Error("generatePkcePair: generated code_verifier failed RFC 7636 validation.");
  }
  return { codeVerifier, codeChallenge: deriveCodeChallenge(codeVerifier) };
}

// S256 challenge: base64url(SHA-256(code_verifier)), no padding. Exposed so the
// callback can recompute and compare without re-minting a verifier.
export function deriveCodeChallenge(codeVerifier: string): string {
  return createHash("sha256").update(codeVerifier, "ascii").digest("base64url");
}

// RFC 7636 length + charset guard. Reusable by the callback to validate a
// verifier read out of the cookie before exchanging it.
export function isValidCodeVerifier(value: string): boolean {
  return (
    value.length >= PKCE_VERIFIER_MIN_LENGTH &&
    value.length <= PKCE_VERIFIER_MAX_LENGTH &&
    VERIFIER_PATTERN.test(value)
  );
}
