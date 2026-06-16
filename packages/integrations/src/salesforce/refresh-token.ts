import { SalesforceError } from "./types.js";

// P1B-03: the OAuth 2.0 refresh-token grant for the per-specialist credential
// (E-03, SEC-AUTH-6, TR-AUTH-4, Immutable #3). `POST /api/v1/auth/refresh`
// calls this with the refresh token P1B-02 stored (AES-256-GCM encrypted on the
// `sessions` row), to mint a fresh access token and — when the Connected App
// rotates — a fresh refresh token.
//
// Distinct from `SalesforceConnectedAppAuth`, which runs the same grant for the
// SERVICE account and caches access tokens: this is a stateless one-shot
// function on the per-specialist credential path, mirroring
// `exchangeAuthorizationCode` — the BFF endpoint owns the storage and the
// rotation, this function only performs the exchange.
//
// Rotation: Salesforce returns a new `refresh_token` ONLY when the Connected
// App has refresh-token rotation enabled; otherwise the field is omitted and
// the existing refresh token stays valid. `refreshToken` is therefore optional
// on the result — the caller stores a new one when present and retains the old
// one when absent (SEC-AUTH-6 honored on the tool side regardless of config).
//
// Secrets posture: the `refresh_token` and `client_secret` travel in the POST
// body only; they never enter a URL, a log line, or a thrown error message.
// OAuth error bodies (`{ error, error_description }`) are diagnostic strings,
// never token material, so they are safe to surface in a `SalesforceError`.

const DEFAULT_TIMEOUT_MS = 10_000;

interface SfTokenResponse {
  access_token?: string;
  refresh_token?: string;
  instance_url?: string;
  scope?: string;
  token_type?: string;
  issued_at?: string;
  expires_in?: number;
}

export interface RefreshTokenExchangeInput {
  // The per-specialist OAuth refresh token (plaintext — the caller decrypts the
  // stored ciphertext before calling). Server-side only (TR-AUTH-3).
  readonly refreshToken: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly loginUrl: string;
}

export interface RefreshTokenExchangeOptions {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export interface RefreshTokenExchangeResult {
  readonly accessToken: string;
  // Present ONLY when the Connected App rotates refresh tokens. Absent means
  // the existing refresh token remains valid — the caller retains it.
  readonly refreshToken?: string;
  readonly instanceUrl: string;
  // Access-token lifetime in seconds. Salesforce's refresh-token grant
  // frequently OMITS `expires_in` (the lifetime is then governed by the org
  // session-timeout setting); the field is optional here so the caller can
  // apply the precise Immutable #3 "80% of TTL" rule when it IS present.
  readonly expiresIn?: number;
  // Space-delimited scopes the access token was granted.
  readonly scope: string;
}

// Exchange a Salesforce refresh token for a fresh access token (RFC 6749
// §6 — refresh-token grant). Throws `SalesforceError` — `SF_AUTH_FAILED` on a
// rejected exchange (`invalid_grant`: the refresh token was revoked, rotated
// away, or expired) or `SF_NETWORK_TIMEOUT` on an aborted request.
export async function exchangeRefreshToken(
  input: RefreshTokenExchangeInput,
  options: RefreshTokenExchangeOptions = {},
): Promise<RefreshTokenExchangeResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const tokenUrl = `${stripTrailingSlash(input.loginUrl)}/services/oauth2/token`;

  // The body is form-encoded; every secret travels in it, never the URL.
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: input.refreshToken,
    client_id: input.clientId,
    client_secret: input.clientSecret,
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
    // `invalid_grant` here means the refresh token is no longer usable — the
    // session is not refreshable and the caller returns 401.
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

  const rotatedRefreshToken =
    typeof parsed.refresh_token === "string" && parsed.refresh_token.length > 0
      ? parsed.refresh_token
      : undefined;

  return {
    accessToken: requireField(parsed.access_token, "access_token"),
    instanceUrl: requireField(parsed.instance_url, "instance_url"),
    // Spread the optionals only when present — `exactOptionalPropertyTypes`
    // forbids an explicit `undefined`.
    ...(rotatedRefreshToken !== undefined
      ? { refreshToken: rotatedRefreshToken }
      : {}),
    ...(isPositiveFiniteNumber(parsed.expires_in)
      ? { expiresIn: parsed.expires_in }
      : {}),
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

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
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
      return `Salesforce token endpoint rejected the refresh (HTTP ${status}, ${parsed.error}${desc})`;
    }
  } catch {
    // Non-JSON body — fall through to the status-only message.
  }
  return `Salesforce token endpoint returned HTTP ${status}`;
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}
