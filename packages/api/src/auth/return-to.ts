// Shared `returnTo` validation for the auth cluster. GET /auth/login (E-01)
// uses it to stash the post-login SPA path in the encrypted `state` cookie;
// GET /auth/callback (E-02) re-validates that path — read back from a cookie
// that could be stale — before it becomes a 302 `Location`.
//
// Pure, I/O-free.

// `returnTo` allowlist (API §7.2.1) — a SPA-relative path. NOTE: `/` is inside
// the character class, so the regex alone ADMITS a protocol-relative URL with
// a dotless host — `//evilhost` matches (open redirect), though `//evil.test`
// does not (the `.` is not in the class). `validateReturnTo` rejects every
// `//`-leading value before the regex; the regex gap is flagged for a spec
// amendment.
export const RETURN_TO_PATTERN = /^\/[a-zA-Z0-9/\-_?=&]+$/;

// Upper bound on `returnTo` length — a path longer than this is rejected
// before it can bloat the encrypted state cookie past the ~4 KB browser limit.
export const RETURN_TO_MAX_LENGTH = 512;

export type ReturnToResult =
  | { readonly kind: "absent" }
  | { readonly kind: "valid"; readonly value: string }
  | { readonly kind: "invalid" };

// Validate an optional `returnTo` value. A null / empty value is treated as
// absent, not an error. The allowlist regex is the primary check; the `//` /
// backslash guard closes the open-redirect the regex alone leaves.
export function validateReturnTo(raw: string | null): ReturnToResult {
  if (raw === null || raw.length === 0) {
    return { kind: "absent" };
  }
  if (raw.length > RETURN_TO_MAX_LENGTH) {
    return { kind: "invalid" };
  }
  // A protocol-relative `//host` is a classic open redirect — and the regex
  // ADMITS the dotless-host form (`//evilhost`), so this guard is load-bearing.
  // The backslash check is defense-in-depth (some browsers fold `\` to `/`).
  if (raw.startsWith("//") || raw.includes("\\")) {
    return { kind: "invalid" };
  }
  if (!RETURN_TO_PATTERN.test(raw)) {
    return { kind: "invalid" };
  }
  return { kind: "valid", value: raw };
}
