// Origin-validation configuration — the CSRF allowlist of frontend origins a
// state-changing request may legitimately come FROM (API §8.6, SEC-THREAT-1).
//
// The SPA's `fetch` is first-party: a mutation request originates from the
// BFF's own deployed origin, so a legitimate `Origin` header equals one of
// these. A request from any other origin is a CSRF attempt — the session
// cookie is sent cross-site because P1B-02 set `SameSite=None` — and is
// rejected with `403 CSRF_ORIGIN_MISMATCH`.
//
// This is a DIFFERENT allowlist from the CSP `frame-ancestors` list (who may
// EMBED the SPA — Salesforce domains; see apps/web/lib/csp.ts). Env-driven so
// each environment (localhost / Vercel preview / production) carries its own
// value with no code change. Pure, I/O-free.

export interface OriginConfig {
  readonly allowedOrigins: readonly string[];
}

export const ENV_ALLOWED_ORIGINS = "ANTHOS_ALLOWED_ORIGINS";

// Dev default — the local Next.js dev server. Deployed environments MUST set
// `ANTHOS_ALLOWED_ORIGINS` explicitly; an unset or empty value there fails
// CLOSED (every mutation 403s), which is the safe direction for a CSRF control.
export const DEFAULT_ALLOWED_ORIGINS: readonly string[] = ["http://localhost:3000"];

type Env = Record<string, string | undefined>;

// Split on commas or whitespace, trim, strip any trailing slash so a value is
// a bare `scheme://host[:port]` ready for an exact compare against `Origin`.
function parseOrigins(raw: string | undefined): readonly string[] {
  if (raw === undefined || raw.trim().length === 0) {
    return DEFAULT_ALLOWED_ORIGINS;
  }
  // A non-empty-but-garbage value resolves to [] — every mutation 403s. That
  // is operator error surfaced loudly, and fails closed, not open.
  return raw
    .split(/[\s,]+/)
    .map((origin) => origin.trim().replace(/\/+$/, ""))
    .filter((origin) => origin.length > 0);
}

export function loadOriginConfig(env: Env = process.env): OriginConfig {
  return { allowedOrigins: parseOrigins(env.ANTHOS_ALLOWED_ORIGINS) };
}
