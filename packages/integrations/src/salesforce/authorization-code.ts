import { SalesforceError } from "./types.js";

// P1B-02: the OAuth 2.0 Authorization Code + PKCE token exchange (E-02,
// SEC-AUTH-1, ARC-12). `GET /api/v1/auth/callback` calls this once, with the
// `code` Salesforce returned and the `code_verifier` it stored (AES-256-GCM
// encrypted in a cookie) at login time.
//
// Distinct from `SalesforceConnectedAppAuth`, which replays a single service
// refresh token and caches access tokens: this is the per-specialist
// credential-issue step, so it is a stateless one-shot function — not a cached
// `SalesforceAuth` implementation.
//
// Immutable #3: PKCE is enforced here — the `code_verifier` proves the caller
// is the same party that began the flow. The `code`, `code_verifier`, and
// `client_secret` travel in the POST body only; they never enter a URL, a log
// line, or a thrown error message. OAuth error bodies (`{ error,
// error_description }`) are diagnostic strings, never token material, so they
// are safe to surface in a `SalesforceError` hint.

const DEFAULT_TIMEOUT_MS = 10_000;

interface SfTokenResponse {
  access_token?: string;
  refresh_token?: string;
  instance_url?: string;
  id?: string;
  scope?: string;
  token_type?: string;
  issued_at?: string;
}

export interface AuthorizationCodeExchangeInput {
  readonly code: string;
  readonly codeVerifier: string;
  readonly clientId: string;
  readonly clientSecret: string;
  // MUST byte-match the `redirect_uri` sent on the /authorize request (RFC 6749
  // §4.1.3) or Salesforce rejects the exchange with `invalid_grant`.
  readonly redirectUri: string;
  readonly loginUrl: string;
}

export interface AuthorizationCodeExchangeOptions {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export interface TokenExchangeResult {
  readonly accessToken: string;
  // The per-specialist OAuth refresh token. Server-side only (TR-AUTH-3,
  // SEC-AUTH-2) — the caller encrypts it before it touches the DB.
  readonly refreshToken: string;
  readonly instanceUrl: string;
  // Salesforce identity URL, e.g.
  // `https://login.salesforce.com/id/<orgId>/<userId>` — the role resolver
  // parses the trailing User Id from it.
  readonly identityUrl: string;
  // Space-delimited scopes the access token was actually granted (BR-01: the
  // caller verifies this against the requested scope).
  readonly scope: string;
}

// Exchange a Salesforce authorization `code` for an access + refresh token.
// Throws `SalesforceError` — `SF_AUTH_FAILED` on a rejected exchange (replayed
// or expired `code`, PKCE-verifier mismatch, missing fields) or
// `SF_NETWORK_TIMEOUT` on an aborted request.
export async function exchangeAuthorizationCode(
  input: AuthorizationCodeExchangeInput,
  options: AuthorizationCodeExchangeOptions = {},
): Promise<TokenExchangeResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const tokenUrl = `${stripTrailingSlash(input.loginUrl)}/services/oauth2/token`;

  // OAuth 2.0 authorization-code grant (RFC 6749 §4.1.3) + PKCE (RFC 7636
  // §4.5). The body is form-encoded; every secret travels in it, never the URL.
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    client_id: input.clientId,
    client_secret: input.clientSecret,
    redirect_uri: input.redirectUri,
    code_verifier: input.codeVerifier,
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  let text: string;
  try {
    response = await fetchImpl(tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: body.toString(),
      signal: controller.signal,
    });
    text = await response.text();
  } catch (err) {
    if ((err as { name?: string }).name === "AbortError") {
      throw new SalesforceError(
        "SF_NETWORK_TIMEOUT",
        `Salesforce token request timed out after ${timeoutMs}ms`,
      );
    }
    // The network-error message can name the host (not a secret); it never
    // carries the form body, so no credential material leaks here.
    throw new SalesforceError(
      "SF_AUTH_FAILED",
      `Salesforce token request failed: ${(err as Error).message ?? "unknown"}`,
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    // `invalid_grant` here means a replayed/expired `code` or a PKCE-verifier
    // mismatch — the FS-01 user-friendly OAuth-failure path.
    throw new SalesforceError(
      "SF_AUTH_FAILED",
      describeOAuthError(response.status, text),
    );
  }

  let parsed: SfTokenResponse;
  try {
    parsed = JSON.parse(text) as SfTokenResponse;
  } catch {
    throw new SalesforceError(
      "SF_AUTH_FAILED",
      `Salesforce token endpoint returned a non-JSON response (HTTP ${response.status})`,
    );
  }

  return {
    accessToken: requireField(parsed.access_token, "access_token"),
    // A missing `refresh_token` means the `refresh_token` scope was not
    // granted — a BR-01 least-privilege misconfiguration; fail the exchange.
    refreshToken: requireField(parsed.refresh_token, "refresh_token"),
    instanceUrl: requireField(parsed.instance_url, "instance_url"),
    identityUrl: requireField(parsed.id, "id"),
    scope: typeof parsed.scope === "string" ? parsed.scope : "",
  };
}

function requireField(value: string | undefined, fieldName: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new SalesforceError(
      "SF_AUTH_FAILED",
      `Salesforce token response contained no ${fieldName}`,
    );
  }
  return value;
}

function describeOAuthError(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as {
      error?: string;
      error_description?: string;
    };
    if (typeof parsed.error === "string") {
      const desc =
        typeof parsed.error_description === "string"
          ? `: ${parsed.error_description}`
          : "";
      return `Salesforce token endpoint rejected the exchange (HTTP ${status}, ${parsed.error}${desc})`;
    }
  } catch {
    // Non-JSON body — fall through to the status-only message.
  }
  return `Salesforce token endpoint returned HTTP ${status}`;
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}
