import { describe, expect, it } from "vitest";

import {
  hashToken,
  hashUserAgent,
  mintToken,
  TOKEN_HASH_LENGTH,
} from "../../src/session/token.js";

describe("session token — mintToken (ADR-03: opaque, 256-bit, non-JWT)", () => {
  it("mints a 256-bit (32-byte) base64url token", () => {
    const token = mintToken();
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
  });

  it("is not a JWT — no dot-delimited segments", () => {
    expect(mintToken()).not.toContain(".");
  });

  it("is unguessable — successive mints differ", () => {
    const tokens = new Set(Array.from({ length: 100 }, () => mintToken()));
    expect(tokens.size).toBe(100);
  });
});

describe("session token — hashToken (DB-dump blast radius)", () => {
  it("returns 64-char lowercase hex (SHA-256)", () => {
    const hash = hashToken(mintToken());
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).toHaveLength(TOKEN_HASH_LENGTH);
  });

  it("is deterministic — the same token always hashes the same", () => {
    const token = mintToken();
    expect(hashToken(token)).toBe(hashToken(token));
  });

  it("never equals the plaintext token — the DB stores only the hash", () => {
    const token = mintToken();
    expect(hashToken(token)).not.toBe(token);
  });

  it("distinct tokens produce distinct hashes", () => {
    expect(hashToken(mintToken())).not.toBe(hashToken(mintToken()));
  });
});

describe("session token — hashUserAgent (no raw UA on the session row)", () => {
  it("returns 64-char lowercase hex (SHA-256)", () => {
    expect(hashUserAgent("Mozilla/5.0 (iPad)")).toMatch(/^[a-f0-9]{64}$/);
  });

  it("is deterministic and never echoes the raw user-agent string", () => {
    const ua = "Mozilla/5.0 (iPad)";
    expect(hashUserAgent(ua)).toBe(hashUserAgent(ua));
    expect(hashUserAgent(ua)).not.toContain("Mozilla");
  });

  it("distinct user agents produce distinct hashes", () => {
    expect(hashUserAgent("Mozilla/5.0 (iPad)")).not.toBe(
      hashUserAgent("Mozilla/5.0 (Macintosh)"),
    );
  });

  it("hashes an absent header deterministically (treats null/undefined as empty)", () => {
    expect(hashUserAgent(null)).toBe(hashUserAgent(undefined));
    expect(hashUserAgent(null)).toMatch(/^[a-f0-9]{64}$/);
  });
});
