// AES-256-GCM authenticated encryption for the short-lived OAuth pre-session
// cookies (`anthos_oauth_state` / `anthos_oauth_pkce`). API §7.2.1 + ERD §3.3
// OSQ-17 keep the PKCE `code_verifier` and CSRF `state` in ENCRYPTED HttpOnly
// cookies rather than a server-side `oauth_states` table — this module is the
// encryption seam.
//
// Wire format: base64url( iv(12) ‖ ciphertext ‖ authTag(16) ). GCM gives both
// confidentiality and integrity, so a tampered cookie fails `aeadDecrypt`
// loudly rather than yielding a forged `code_verifier` / `state`.
//
// Pure, I/O-free, dependency-free apart from `node:crypto` — `@anthos/auth`
// must stay at the bottom of the dependency graph (no `@anthos/persistence`,
// no `@anthos/audit`).
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// GCM standard 96-bit nonce. A fresh random IV is generated per encryption —
// it is never reused under the same key (GCM nonce reuse is catastrophic).
export const AEAD_IV_BYTES = 12;

// GCM authentication-tag length.
export const AEAD_TAG_BYTES = 16;

// AES-256 key length.
export const AEAD_KEY_BYTES = 32;

const CIPHER = "aes-256-gcm";

// Encrypt a UTF-8 plaintext under `key` (a raw 32-byte AES-256 key). Returns
// base64url( iv ‖ ciphertext ‖ authTag ) — URL- and cookie-safe, no padding.
export function aeadEncrypt(plaintext: string, key: Buffer): string {
  assertKey(key);
  const iv = randomBytes(AEAD_IV_BYTES);
  const cipher = createCipheriv(CIPHER, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ciphertext, tag]).toString("base64url");
}

// Decrypt a token produced by `aeadEncrypt`. Throws on a tampered ciphertext
// or tag, the wrong key, or malformed / truncated input — it never returns a
// partial or forged value.
export function aeadDecrypt(token: string, key: Buffer): string {
  assertKey(key);
  const raw = Buffer.from(token, "base64url");
  if (raw.length < AEAD_IV_BYTES + AEAD_TAG_BYTES) {
    throw new Error("aeadDecrypt: input too short to contain an IV and an auth tag.");
  }
  const iv = raw.subarray(0, AEAD_IV_BYTES);
  const tag = raw.subarray(raw.length - AEAD_TAG_BYTES);
  const ciphertext = raw.subarray(AEAD_IV_BYTES, raw.length - AEAD_TAG_BYTES);
  const decipher = createDecipheriv(CIPHER, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

// Decode the base64 env secret into a raw 32-byte AES key. Throws a descriptive
// error naming the env var — never echoing the secret value — when the secret
// is absent, not base64, or does not decode to exactly 32 bytes.
export function decodeCookieKey(base64Secret: string, envName: string): Buffer {
  if (base64Secret.trim().length === 0) {
    throw new Error(`${envName} is not set; the OAuth cookie key cannot be derived.`);
  }
  const key = Buffer.from(base64Secret, "base64");
  if (key.length !== AEAD_KEY_BYTES) {
    throw new Error(
      `${envName} must decode to exactly ${AEAD_KEY_BYTES} bytes (base64); ` +
        `got ${key.length}. Generate with: openssl rand -base64 32`,
    );
  }
  return key;
}

function assertKey(key: Buffer): void {
  if (key.length !== AEAD_KEY_BYTES) {
    throw new Error(
      `OAuth cookie key must be ${AEAD_KEY_BYTES} bytes (AES-256); got ${key.length}.`,
    );
  }
}
