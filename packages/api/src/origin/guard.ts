// `enforceOrigin` — the CSRF Origin-validation guard run as the first step of
// every mutation endpoint (POST/PATCH/DELETE) per API §8.6 + SEC-THREAT-1.
// `SameSite=None` (P1B-02) lets the session cookie ride a cross-site request,
// so the cookie alone is not a CSRF defense; this guard is.
//
// On a mismatch it writes ONE `auth.failure` audit row (the API §11.6 catalog
// action type for an auth-boundary rejection), tagged
// `payloadMetadata.reason = "csrf_origin_mismatch"`, BEFORE returning the 403
// (Immutable #5 / SEC-AUDIT-7), then returns the response. On a pass it
// returns null and the caller proceeds. It runs ahead of cookie parsing, the
// idempotency lock, and rate limiting — a CSRF-rejected request consumes none
// of those.
//
// Audit actor: the check runs before session resolution (fail-fast) and we
// deliberately do not look up or trust the request's cookie on a rejected
// request, so the row is attributed to the `anonymous` sentinel. The rejected
// `Origin` is a bare domain (benign, not PII) recorded — after shape
// sanitization — in `payload_metadata` for forensics.

import { writeAuditEntry } from "@anthos/audit";
import type { StructuredLogger } from "@anthos/logging";
import type { DbOrTx } from "@anthos/persistence";

import { loadOriginConfig } from "./config.js";
import type { OriginConfig } from "./config.js";
import { csrfOriginMismatchResponse } from "./responses.js";
import { isOriginAllowed, isSafeMethod, sanitizeOriginForAudit } from "./validate.js";

// Sentinel actor for an Origin-mismatch audit row — see the module header.
const CSRF_AUDIT_ACTOR = "anonymous";
// API §11.6 catalogs `auth.failure` as the action type for an auth-boundary
// rejection (there is no `security.*` action type); the specific failure mode
// rides in `payloadMetadata.reason`, mirroring `writeAuthFailure` in the
// refresh handler.
const CSRF_AUDIT_ACTION = "auth.failure";
const CSRF_FAILURE_REASON = "csrf_origin_mismatch";

export interface EnforceOriginDeps {
  // CSRF allowlist. Omitted → the memoized env-driven `loadOriginConfig()`.
  readonly config?: OriginConfig;
  // Resolves the DB handle for the audit INSERT. Invoked ONLY on the reject
  // path, so the happy path (and logout's no-cookie no-op) stay DB-free.
  readonly getDb: () => Promise<DbOrTx>;
  readonly traceId: string;
  // Per-request structured logger — already bound to `traceId` by the caller.
  readonly logger: StructuredLogger;
}

// Memoized default config — `loadOriginConfig` reads `process.env`, fixed at
// boot, so resolving it once per process is sufficient (mirrors withSession).
let defaultConfig: OriginConfig | undefined;

function resolveConfig(injected: OriginConfig | undefined): OriginConfig {
  if (injected !== undefined) {
    return injected;
  }
  defaultConfig ??= loadOriginConfig();
  return defaultConfig;
}

// Returns a 403 Response when the request's Origin is not permitted (after
// writing the audit row), or null when the request may proceed.
export async function enforceOrigin(
  req: Request,
  deps: EnforceOriginDeps,
): Promise<Response | null> {
  // Safe methods are never CSRF-validated (ticket AC). Defensive: this guard
  // is only wired into POST handlers, but the check keeps it reusable.
  if (isSafeMethod(req.method)) {
    return null;
  }

  const config = resolveConfig(deps.config);
  const origin = req.headers.get("Origin");
  if (isOriginAllowed(origin, config)) {
    return null;
  }

  // Mismatch — write the audit row BEFORE the response (Immutable #5 /
  // SEC-AUDIT-7). A write failure propagates: the request must not 403
  // silently without a durable audit trail (no fire-and-forget).
  const db = await deps.getDb();
  await writeAuditEntry(db, {
    specialistId: CSRF_AUDIT_ACTOR,
    actionType: CSRF_AUDIT_ACTION,
    outcome: "FAILED",
    traceId: deps.traceId,
    payloadMetadata: {
      reason: CSRF_FAILURE_REASON,
      origin: sanitizeOriginForAudit(origin),
      method: req.method.toUpperCase(),
    },
  });
  // Correlation id only — the rejected Origin lives on the audit row, not the
  // log line, and never in the response body.
  deps.logger.warn("origin validation rejected a mutation request", {
    event: "csrf_origin_mismatch",
  });
  return csrfOriginMismatchResponse(deps.traceId);
}
