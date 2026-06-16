// Client-side `Idempotency-Key` generator for every mutation surface
// (TR-OFFLINE-6a + TR-WRITE-2c + Pattern D + Immutable #6). One key per
// *user action*, generated at submission/enqueue time so retries — whether
// transparent middleware retries against the BFF or offline-queue replays
// after reconnect — land on the same idempotency row server-side and return
// the stored response instead of duplicating a Salesforce write.
//
// `crypto.randomUUID()` is the Web Crypto API primitive: cryptographically
// strong (no `Math.random`), no PII derivation, RFC 4122 v4 by construction.
// Available on every browser the tool targets (Chromium 92+, Safari 15.4+ /
// iPadOS 15.4+) and on Node 19+ for CI / Production substrate.

export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}
