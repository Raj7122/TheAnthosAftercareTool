// GET /api/v1/auth/login (endpoint E-01) — the entry point of the Salesforce
// OAuth Authorization Code + PKCE flow (F-01, TR-AUTH-1, SEC-AUTH-1, ARC-12).
//
// Mints a fresh PKCE `code_verifier` + S256 challenge and a CSRF `state`,
// persists the verifier and state in two AES-256-GCM-encrypted HttpOnly
// cookies (`anthos_oauth_pkce` / `anthos_oauth_state` — API §7.2.1 + ERD §3.3
// OSQ-17 keep these in encrypted cookies, not a server-side `oauth_states`
// table), and 302-redirects the browser to Salesforce's
// /services/oauth2/authorize. No token, `code_verifier`, or `state` material
// ever reaches the browser bundle: the cookie values are ciphertext, and the
// verifier / state never enter a response body or a log line.
//
// /auth/login is a PUBLIC endpoint — there is no session yet — so it is NOT
// wrapped by `withSession` and resolves its own trace_id. API §6 marks E-01's
// audit as "(none — initiation)": there is no authenticated `specialistId` to
// satisfy the audit writer, so this endpoint writes NO `audit_log` row in any
// path. The initiation breadcrumb and both failure paths are structured log
// lines (@anthos/logging), matching the `withSession` rejection-logging
// precedent ("a rejected request is not a state mutation").

import {
  aeadEncrypt,
  buildAuthorizeUrl,
  encodePkcePayload,
  encodeStatePayload,
  generateOAuthState,
  generatePkcePair,
  serializeOAuthPkceCookie,
  serializeOAuthStateCookie,
} from "@anthos/auth";
import type { OAuthCookieAttributes, OAuthStatePayload } from "@anthos/auth";
import { createLogger, resolveTraceId } from "@anthos/logging";
import type { StructuredLogger } from "@anthos/logging";

import { loadOAuthLoginConfig } from "./config.js";
import type { OAuthLoginConfig } from "./config.js";
import { authErrorResponse } from "./responses.js";
import { validateReturnTo } from "./return-to.js";

// Cookie path — scopes the OAuth cookies to the auth flow so they are not sent
// on every request. P1B-02's clear-cookie (`callback.ts`) imports this so the
// two endpoints set and clear the cookies on the exact same path.
export const OAUTH_COOKIE_PATH = "/api/v1/auth";

// Structured logger for this endpoint; a per-request child binds trace_id.
const defaultLogger = createLogger({ module: "api.auth" });

export interface AuthLoginOptions {
  // Injected for tests — defaults to `loadOAuthLoginConfig()` (memoized).
  readonly config?: OAuthLoginConfig;
  // Injected for tests — defaults to the `api.auth` logger.
  readonly logger?: StructuredLogger;
}

// Memoized default config — `loadOAuthLoginConfig` reads `process.env`, fixed
// at boot. A throw is NOT memoized (the assignment never lands), so a
// misconfigured deploy keeps failing loudly per request rather than once.
let defaultConfig: OAuthLoginConfig | undefined;

function resolveConfig(injected: OAuthLoginConfig | undefined): OAuthLoginConfig {
  if (injected !== undefined) {
    return injected;
  }
  defaultConfig ??= loadOAuthLoginConfig();
  return defaultConfig;
}

// The full E-01 handler. Resolves trace_id, loads config, validates `returnTo`,
// mints PKCE + state, encrypts the two cookies, builds the authorize URL, and
// returns 302 with `Location`, two `Set-Cookie`, `Cache-Control: no-store`,
// and `X-Trace-Id`.
export async function handleAuthLogin(
  req: Request,
  options: AuthLoginOptions = {},
): Promise<Response> {
  const traceId = resolveTraceId(req);
  const log = (options.logger ?? defaultLogger).child({ traceId });

  // Config: a missing / malformed env var is operator error → 500. The thrown
  // message names the env var (safe — names are not secrets) and is logged
  // only; it is never echoed to the browser.
  let config: OAuthLoginConfig;
  try {
    config = resolveConfig(options.config);
  } catch (err) {
    log.error("oauth login configuration error", {
      event: "oauth_login_config_error",
      reason: err instanceof Error ? err.message : String(err),
    });
    return authErrorResponse("AUTH_CONFIG_ERROR", traceId);
  }

  // `returnTo` (API §7.2.1) — optional SPA path, allowlist-validated.
  const returnTo = validateReturnTo(new URL(req.url).searchParams.get("returnTo"));
  if (returnTo.kind === "invalid") {
    // The rejected value is attacker-controlled (an open-redirect payload) —
    // it is NEVER logged or echoed; only the param name surfaces.
    log.warn("oauth login rejected an invalid returnTo", {
      event: "oauth_login_invalid_return_to",
    });
    return authErrorResponse("INVALID_QUERY_PARAM", traceId, {
      param: "returnTo",
    });
  }

  try {
    const { codeVerifier, codeChallenge } = generatePkcePair();
    const state = generateOAuthState();

    const statePayload: OAuthStatePayload =
      returnTo.kind === "valid" ? { state, returnTo: returnTo.value } : { state };
    const encryptedState = aeadEncrypt(encodeStatePayload(statePayload), config.cookieKey);
    const encryptedPkce = aeadEncrypt(encodePkcePayload({ codeVerifier }), config.cookieKey);

    const cookieAttrs: OAuthCookieAttributes = {
      secure: config.cookieSecure,
      sameSite: config.cookieSameSite,
      path: OAUTH_COOKIE_PATH,
      maxAgeSeconds: config.cookieMaxAgeSeconds,
    };

    const authorizeUrl = buildAuthorizeUrl({
      loginUrl: config.loginUrl,
      clientId: config.clientId,
      redirectUri: config.redirectUri,
      codeChallenge,
      state,
      scope: config.scope,
    });

    // Build headers directly: two distinct `Set-Cookie` values must be
    // appended (not `set`, which overwrites). `X-Trace-Id` is set here rather
    // than via `echoTraceId` so the multi-valued `Set-Cookie` is not disturbed.
    const headers = new Headers();
    headers.set("Location", authorizeUrl);
    headers.set("Cache-Control", "no-store");
    headers.set("X-Trace-Id", traceId);
    headers.append("Set-Cookie", serializeOAuthStateCookie(encryptedState, cookieAttrs));
    headers.append("Set-Cookie", serializeOAuthPkceCookie(encryptedPkce, cookieAttrs));

    // Initiation breadcrumb — correlation only. The `state`, `code_verifier`,
    // and `code_challenge` are NEVER placed in a log field.
    log.info("oauth login initiated", { event: "oauth_login_initiated" });

    return new Response(null, { status: 302, headers });
  } catch (err) {
    // No silent catch — a crypto / URL-build failure surfaces
    // structured. There is no `specialistId`, so no `audit_log` row.
    log.error("oauth login failed to build the authorize redirect", {
      event: "oauth_login_internal_error",
      reason: err instanceof Error ? err.message : String(err),
    });
    return authErrorResponse("AUTH_CONFIG_ERROR", traceId);
  }
}
