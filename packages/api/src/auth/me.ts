// GET /api/v1/me (endpoint E-05) — the SPA's single source of truth for the
// role gate (API §6.1, §7.2.5; F-01, TR-AUTH-8, SEC-AUTHZ-1, ARC-13, ARC-22).
// Returns the signed-in specialist's identity, role, session expiry, first-run
// state, and resolved feature flags.
//
// A read endpoint: no audit row (API §6 marks E-05 audit `(none)` — a state
// read is not a mutation), no `Idempotency-Key`, no app-level rate limit.
// `withSession` (P1A-04) owns the auth gate — cookie parse, session lookup,
// idle/absolute expiry, and the AUTH_SESSION_INVALID / AUTH_SESSION_EXPIRED
// 401s — so the core runs only for a live session.
//
// Identity (displayName/email/timezone) + role come off the session row,
// captured from Salesforce at `/auth/callback` (P1B-05): `/me` makes no
// Salesforce call and rotates no credential. Per-request role re-resolution +
// the 60s role cache (API §8.3 / TR-AUTH-8 "every authz-sensitive request")
// are deferred to the Production Readiness Ratchet — flagged in the PR body.
//
// All logic lives here so it is unit-testable without a Next runtime;
// `apps/web` carries only a thin route shim.

import { computePermissionsHash } from "@anthos/auth";
import type { Role, SessionConfig } from "@anthos/auth";
import type { FeatureFlagClient } from "@anthos/feature-flags";
import { getKnownBarrierTypesOrdered } from "@anthos/integrations";
import { createLogger, resolveTraceId } from "@anthos/logging";
import type { StructuredLogger } from "@anthos/logging";

import { getFeatureFlagClient } from "../feature-flags/index.js";
import { withSession } from "../session/middleware.js";
import type {
  SessionHandler,
  SessionRequestContext,
} from "../session/middleware.js";
import { sessionErrorResponse } from "../session/responses.js";
import type { SessionStore } from "../session/store.js";

// Structured logger for this endpoint; a per-request child binds trace_id.
const defaultLogger = createLogger({ module: "api.auth" });

const JSON_CONTENT_TYPE = "application/json; charset=utf-8";

// The feature flags `/me` exposes in `features` (API §7.2.5): the four M-AI
// per-specialist flags (ADR-08, ARC-22). Surfacing another client-relevant
// flag is a one-line addition here.
export const ME_FEATURE_FLAG_KEYS = [
  "feature.m_ai.summary",
  "feature.m_ai.voice",
  "feature.m_ai.signal",
  "feature.m_ai.draft",
] as const;

// Resolve the onboarding-tour flag for a specialist (API §7.2.5
// `firstRunCompleted`). The default reads `notification_preferences`.
export type FirstRunLookup = (specialistId: string) => Promise<boolean>;

// Resolve the F-06 Barrier Type picklist for the SPA's session-start bootstrap
// (EC-22 — mid-session enum changes fall back to last-known). Default returns
// the FS v1.12 §F-06 ordered snapshot from `@anthos/integrations`.
export type BarrierTypesLookup = () => ReadonlyArray<string>;

export interface AuthMeOptions {
  // Injected for tests — the session store the auth gate resolves against.
  readonly store?: SessionStore;
  // Injected for tests — defaults to `loadSessionConfig()` inside withSession.
  readonly config?: SessionConfig;
  // Injected for tests — defaults to the process-scoped flag client.
  readonly featureFlagClient?: FeatureFlagClient;
  // Injected for tests — defaults to a `notification_preferences` read.
  readonly firstRunLookup?: FirstRunLookup;
  // Injected for tests — defaults to `getKnownBarrierTypesOrdered()`.
  readonly barrierTypesLookup?: BarrierTypesLookup;
  // Injected for tests — defaults to the `api.auth` logger.
  readonly logger?: StructuredLogger;
}

// Default `firstRunCompleted` lookup — a `notification_preferences` read. The
// dynamic import keeps the @anthos/persistence connection side effect out of
// @anthos/api's static import graph (mirrors the other auth handlers).
async function defaultFirstRunLookup(specialistId: string): Promise<boolean> {
  const { db, repositories } = await import("@anthos/persistence");
  return repositories.getFirstRunCompleted(db, specialistId);
}

// The full E-05 handler. `withSession` owns the auth gate; `buildMeResponse`
// builds the API §7.2.5 body for a live session. A safety net converts an
// unexpected throw (e.g. the session store is unreachable) into a structured
// 500 rather than letting an unhandled error escape to the Next runtime.
export async function handleMe(
  req: Request,
  options: AuthMeOptions = {},
): Promise<Response> {
  const traceId = resolveTraceId(req);
  const log = (options.logger ?? defaultLogger).child({ traceId });
  const flagClient = options.featureFlagClient ?? getFeatureFlagClient();
  const firstRunLookup = options.firstRunLookup ?? defaultFirstRunLookup;
  const barrierTypesLookup =
    options.barrierTypesLookup ?? getKnownBarrierTypesOrdered;

  const meCore: SessionHandler = (_req, ctx) =>
    buildMeResponse(ctx, flagClient, firstRunLookup, barrierTypesLookup, log);

  // exactOptionalPropertyTypes forbids handing withSession an explicit
  // `undefined` — spread each injected seam only when supplied.
  const sessionOptions = {
    ...(options.store !== undefined ? { store: options.store } : {}),
    ...(options.config !== undefined ? { config: options.config } : {}),
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
  };

  try {
    return await withSession(meCore, sessionOptions)(req);
  } catch (err) {
    // No silent catch. withSession's own rejection modes return
    // their 401 directly; reaching here is infrastructure (e.g. the session
    // store is unreachable) — a 500, never a 401: an unknown fault must not
    // force a spurious re-login of a session that may be perfectly valid.
    log.error("me request failed unexpectedly", {
      event: "me_internal_error",
      reason: errorReason(err),
    });
    return internalErrorResponse(traceId);
  }
}

// Build the API §7.2.5 success body for a session the middleware resolved.
async function buildMeResponse(
  ctx: SessionRequestContext,
  flagClient: FeatureFlagClient,
  firstRunLookup: FirstRunLookup,
  barrierTypesLookup: BarrierTypesLookup,
  log: StructuredLogger,
): Promise<Response> {
  // Identity is captured at session start (P1B-05). A null means a session
  // minted before the identity-capture migration — treat it as stale and
  // force a clean re-auth rather than emit a half-populated identity. Demo
  // sessions live ≤12h, so this window self-heals quickly.
  if (ctx.displayName === null || ctx.email === null || ctx.timezone === null) {
    log.warn("me request on a session predating identity capture", {
      event: "me_session_identity_absent",
    });
    return sessionErrorResponse("AUTH_SESSION_INVALID", ctx.traceId);
  }

  // Feature flags — the wrapper is fail-closed (an error resolves OFF), so
  // these calls never throw (P1A-05).
  const flagContext = { specialistId: ctx.specialistId, role: ctx.role };
  const flagEntries = await Promise.all(
    ME_FEATURE_FLAG_KEYS.map(
      async (key) =>
        [key, await flagClient.isEnabled(key, flagContext)] as const,
    ),
  );
  const features = Object.fromEntries(flagEntries);

  // first-run flag — a non-critical UI signal. If the read fails, degrade to
  // the §7.2.5 gap-aware default (false) and log: a notification_preferences
  // hiccup must not 500 the role gate. Logged, never silently swallowed.
  let firstRunCompleted = false;
  try {
    firstRunCompleted = await firstRunLookup(ctx.specialistId);
  } catch (err) {
    log.warn("me could not read the first-run flag; defaulting to false", {
      event: "me_first_run_lookup_failed",
      reason: errorReason(err),
    });
  }

  // F-06 Barrier Type picklist for session-start bootstrap (EC-22 — mid-
  // session enum changes fall back to last-known). The SPA's Create Barrier
  // sheet renders the picker from this list; no second hard-coded mapping in
  // the UI layer.
  const barrierTypes = barrierTypesLookup();

  // DEMO-ONLY persona label. When the demo runs the curated caseload under a
  // working OAuth login that differs from the specialist the data belongs to
  // (e.g. Marie Alcis's records served under the dev login), this overrides
  // ONLY the cosmetic greeting name. `specialistId` (the authz subject and the
  // Salesforce owner filter) is untouched — this never changes who the session
  // is. Leave `DEMO_SPECIALIST_DISPLAY_NAME` unset in production.
  const displayName =
    process.env.DEMO_SPECIALIST_DISPLAY_NAME ?? ctx.displayName;

  // Field order matches the API §7.2.5 example payload.
  const body = {
    specialistId: ctx.specialistId,
    displayName,
    email: ctx.email,
    role: roleToWire(ctx.role),
    timezone: ctx.timezone,
    permissionsHash: computePermissionsHash(ctx.specialistId, ctx.role),
    sessionExpiresAt: ctx.expiresAt.toISOString(),
    firstRunCompleted,
    features,
    barrierTypes,
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "Content-Type": JSON_CONTENT_TYPE,
      // /me carries the specialist's own identity — never cached or shared.
      "Cache-Control": "no-store",
      "X-Trace-Id": ctx.traceId,
    },
  });
}

// The API §7.2.5 `role` enum is lowercase (`specialist` … `system_admin`); the
// internal `Role` is uppercase. `.toLowerCase()` maps all four exactly —
// `SYSTEM_ADMIN` → `system_admin`.
function roleToWire(role: Role): string {
  return role.toLowerCase();
}

// Reduce an unknown thrown value to a short log string. Mirrors the helper in
// `callback.ts` / `refresh.ts` — the reason rides the structured log only.
function errorReason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// API §7.1.2 / §9.2.2 — `INTERNAL_ERROR` (500). No PII, no internals in the
// message; the cause is on the structured log, correlated by `traceId`.
function internalErrorResponse(traceId: string): Response {
  return new Response(
    JSON.stringify({
      code: "INTERNAL_ERROR",
      message: "Something went wrong. Please try again.",
      traceId,
    }),
    {
      status: 500,
      headers: {
        "Content-Type": JSON_CONTENT_TYPE,
        "Cache-Control": "no-store",
        "X-Trace-Id": traceId,
      },
    },
  );
}
