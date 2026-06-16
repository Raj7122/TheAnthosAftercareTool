// Pure predicates for the CSRF Origin check (API §8.6). No I/O.

import type { OriginConfig } from "./config.js";

// Safe HTTP methods carry no CSRF risk — a cross-origin GET cannot mutate
// state, and browsers do not reliably send `Origin` on simple GETs. Origin
// validation applies to state mutations only (ticket AC; API §8.6).
const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

export function isSafeMethod(method: string): boolean {
  return SAFE_METHODS.has(method.toUpperCase());
}

// A mutation request passes the CSRF Origin check only when it carries an
// `Origin` header whose value is in the configured allowlist. A missing Origin
// on a mutation is itself a rejection: modern browsers always send `Origin` on
// POST/PATCH/DELETE, so its absence is anomalous (API §8.6 handoff note).
export function isOriginAllowed(origin: string | null, config: OriginConfig): boolean {
  if (origin === null || origin.trim().length === 0) {
    return false;
  }
  const normalized = origin.trim().replace(/\/+$/, "");
  return config.allowedOrigins.includes(normalized);
}

// A browser-set `Origin` is always a bare `scheme://host[:port]` (or the
// literal `null` for an opaque origin). `sanitizeOriginForAudit` records the
// value only when it has that shape; anything else came from a non-browser
// client and is recorded as `malformed`, so an adversarial header value can
// never reach the audit row's `payload_metadata` (SEC-AUDIT-4 / pii-firewall).
const ORIGIN_SHAPE = /^[a-z][a-z0-9+.-]*:\/\/[a-z0-9.\-:[\]]+$/i;

export function sanitizeOriginForAudit(origin: string | null): string {
  if (origin === null) {
    return "absent";
  }
  const trimmed = origin.trim();
  if (trimmed.length === 0) {
    return "absent";
  }
  if (trimmed === "null") {
    return "null";
  }
  return ORIGIN_SHAPE.test(trimmed) ? trimmed : "malformed";
}
