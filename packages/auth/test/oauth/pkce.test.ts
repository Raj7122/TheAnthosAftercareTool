import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  deriveCodeChallenge,
  generatePkcePair,
  isValidCodeVerifier,
  PKCE_CHALLENGE_METHOD,
  PKCE_VERIFIER_MAX_LENGTH,
  PKCE_VERIFIER_MIN_LENGTH,
} from "../../src/oauth/pkce.js";

// base64url alphabet — the subset of RFC 7636's unreserved set this code emits.
const UNRESERVED = /^[A-Za-z0-9\-_]+$/;

describe("PKCE — generatePkcePair (RFC 7636)", () => {
  it("mints a code_verifier within the 43–128 char bound", () => {
    const { codeVerifier } = generatePkcePair();
    expect(codeVerifier.length).toBeGreaterThanOrEqual(PKCE_VERIFIER_MIN_LENGTH);
    expect(codeVerifier.length).toBeLessThanOrEqual(PKCE_VERIFIER_MAX_LENGTH);
  });

  it("the code_verifier uses only the unreserved (base64url) charset", () => {
    expect(generatePkcePair().codeVerifier).toMatch(UNRESERVED);
  });

  it("the code_challenge is padless base64url — no '=', '+', or '/'", () => {
    const { codeChallenge } = generatePkcePair();
    expect(codeChallenge).toMatch(UNRESERVED);
    expect(codeChallenge).not.toContain("=");
  });

  it("uses the S256 challenge method — never plain (SEC-AUTH-1)", () => {
    expect(PKCE_CHALLENGE_METHOD).toBe("S256");
  });

  it("the pair's challenge equals deriveCodeChallenge(verifier)", () => {
    const { codeVerifier, codeChallenge } = generatePkcePair();
    expect(deriveCodeChallenge(codeVerifier)).toBe(codeChallenge);
  });

  it("is unguessable — 100 successive verifiers are all distinct", () => {
    const verifiers = new Set(Array.from({ length: 100 }, () => generatePkcePair().codeVerifier));
    expect(verifiers.size).toBe(100);
  });
});

describe("PKCE — deriveCodeChallenge (S256)", () => {
  it("equals base64url(SHA-256(ASCII(verifier))) — RFC 7636 §4.2", () => {
    const verifier = "a".repeat(43);
    const expected = createHash("sha256").update(verifier, "ascii").digest("base64url");
    expect(deriveCodeChallenge(verifier)).toBe(expected);
  });

  it("is deterministic — the same verifier always derives the same challenge", () => {
    const verifier = generatePkcePair().codeVerifier;
    expect(deriveCodeChallenge(verifier)).toBe(deriveCodeChallenge(verifier));
  });
});

describe("PKCE — isValidCodeVerifier", () => {
  it("accepts a 43-char unreserved verifier", () => {
    expect(isValidCodeVerifier("a".repeat(43))).toBe(true);
  });

  it("rejects a too-short (<43) verifier", () => {
    expect(isValidCodeVerifier("a".repeat(42))).toBe(false);
  });

  it("rejects a too-long (>128) verifier", () => {
    expect(isValidCodeVerifier("a".repeat(129))).toBe(false);
  });

  it("rejects a verifier carrying a non-unreserved char", () => {
    expect(isValidCodeVerifier(`${"a".repeat(42)}+`)).toBe(false);
    expect(isValidCodeVerifier(`${"a".repeat(42)} `)).toBe(false);
  });
});
