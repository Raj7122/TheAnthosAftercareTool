import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  aeadDecrypt,
  aeadEncrypt,
  AEAD_KEY_BYTES,
  decodeCookieKey,
} from "../../src/oauth/crypto.js";

// A fresh random key per call — never a hardcoded secret in source.
const key = (): Buffer => randomBytes(AEAD_KEY_BYTES);

describe("OAuth crypto — aeadEncrypt / aeadDecrypt (AES-256-GCM)", () => {
  it("round-trips an arbitrary UTF-8 plaintext", () => {
    const k = key();
    const plaintext = JSON.stringify({ state: "abc", returnTo: "/x/é" });
    expect(aeadDecrypt(aeadEncrypt(plaintext, k), k)).toBe(plaintext);
  });

  it("produces base64url ciphertext — cookie-safe (no ';', '=', '+', '/')", () => {
    expect(aeadEncrypt("payload", key())).toMatch(/^[A-Za-z0-9\-_]+$/);
  });

  it("uses a fresh IV — same plaintext + key encrypts differently each call", () => {
    const k = key();
    expect(aeadEncrypt("same", k)).not.toBe(aeadEncrypt("same", k));
  });

  it("throws when the ciphertext is tampered (bad auth tag)", () => {
    const k = key();
    const token = aeadEncrypt("payload", k);
    // Flip the first char — corrupts the IV, so GCM authentication fails.
    const tampered = (token.startsWith("A") ? "B" : "A") + token.slice(1);
    expect(() => aeadDecrypt(tampered, k)).toThrow();
  });

  it("throws when decrypted under the wrong key", () => {
    const token = aeadEncrypt("payload", key());
    expect(() => aeadDecrypt(token, key())).toThrow();
  });

  it("throws on malformed / truncated input", () => {
    expect(() => aeadDecrypt("short", key())).toThrow();
    expect(() => aeadDecrypt("", key())).toThrow();
  });
});

describe("OAuth crypto — decodeCookieKey", () => {
  it("decodes a valid base64 32-byte secret to a 32-byte Buffer", () => {
    const secret = randomBytes(AEAD_KEY_BYTES).toString("base64");
    expect(decodeCookieKey(secret, "ANTHOS_OAUTH_COOKIE_SECRET")).toHaveLength(AEAD_KEY_BYTES);
  });

  it("throws — naming the env var — on an empty secret", () => {
    expect(() => decodeCookieKey("", "ANTHOS_OAUTH_COOKIE_SECRET")).toThrow(
      /ANTHOS_OAUTH_COOKIE_SECRET/,
    );
  });

  it("throws — naming the env var — on a wrong-length secret", () => {
    const short = randomBytes(16).toString("base64");
    expect(() => decodeCookieKey(short, "ANTHOS_OAUTH_COOKIE_SECRET")).toThrow(
      /ANTHOS_OAUTH_COOKIE_SECRET/,
    );
  });
});
