import { SalesforceError, type SalesforceAuth } from "./types.js";

// P0-12a: server-to-server Salesforce auth for the deployed BFF (Vercel).
//
// `SfCliKeychainAuth` (auth.ts) reads the local `sf` CLI keychain — which does
// not exist on Vercel. This class authenticates the deployed BFF against the
// anonymized sandbox using the PF-09 Connected App (`Anthos_Aftercare_Demo`).
// It stays a sibling of `SfCliKeychainAuth`: the CLI path remains the
// local-engineering default; `selectSalesforceAuth()` in the calibration
// orchestrator picks between them by env-var presence.
//
// Immutable #3 (OAuth 2.0 + PKCE for all Salesforce auth): the PF-09 Connected
// App enables only the Authorization Code + PKCE flow (`isPkceRequired=true`;
// the `client_credentials` and JWT-bearer grants are disabled). The refresh
// token consumed here is minted ONCE by an interactive auth-code + PKCE
// bootstrap and stored as
// the `SF_CONNECTED_APP_REFRESH_TOKEN` secret. PKCE therefore happens at
// credential-issue time; this class only replays the refresh token to obtain
// access tokens — the same posture `SfCliKeychainAuth` documents. The consumer
// secret and the refresh/access tokens are passed server-side only and never
// reach logs, error messages, or the browser.

const DEFAULT_TIMEOUT_MS = 10_000;

// Immutable #3 specifies "refresh at 80% of TTL." Salesforce returns the
// access-token TTL in the token response's `expires_in` (seconds) when it is
// present; the cache then expires at 0.8 × that value. Salesforce's
// refresh-token grant frequently OMITS `expires_in` — the access token's life
// is then governed by the org session-timeout setting (15-minute minimum).
// When `expires_in` is absent we fall back to this fixed TTL, kept safely
// under that 15-minute floor so a cached token is never served past expiry.
const FALLBACK_TOKEN_TTL_MS = 10 * 60_000;

interface CachedTokenInfo {
  accessToken: string;
  instanceUrl: string;
  fetchedAt: number;
  ttlMs: number;
}

interface SfTokenResponse {
  access_token?: string;
  instance_url?: string;
  token_type?: string;
  issued_at?: string;
  signature?: string;
  scope?: string;
  id?: string;
  expires_in?: number;
}

export interface SalesforceConnectedAppAuthOptions {
  // Default to the PF-09 env vars. Injected values exist for tests.
  readonly consumerKey?: string;
  readonly consumerSecret?: string;
  readonly loginUrl?: string;
  readonly refreshToken?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

export class SalesforceConnectedAppAuth implements SalesforceAuth {
  private readonly consumerKey: string;
  private readonly consumerSecret: string;
  private readonly loginUrl: string;
  private readonly refreshToken: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private cached: CachedTokenInfo | null = null;

  constructor(options: SalesforceConnectedAppAuthOptions = {}) {
    this.consumerKey = requireValue(
      options.consumerKey ?? process.env["SF_CONNECTED_APP_CONSUMER_KEY"],
      "SF_CONNECTED_APP_CONSUMER_KEY",
    );
    this.consumerSecret = requireValue(
      options.consumerSecret ?? process.env["SF_CONNECTED_APP_CONSUMER_SECRET"],
      "SF_CONNECTED_APP_CONSUMER_SECRET",
    );
    this.loginUrl = stripTrailingSlash(
      requireValue(options.loginUrl ?? process.env["SF_LOGIN_URL"], "SF_LOGIN_URL"),
    );
    this.refreshToken = requireValue(
      options.refreshToken ?? process.env["SF_CONNECTED_APP_REFRESH_TOKEN"],
      "SF_CONNECTED_APP_REFRESH_TOKEN",
    );
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
  }

  async getAccessToken(): Promise<string> {
    const info = await this.resolve();
    return info.accessToken;
  }

  async getInstanceUrl(): Promise<string> {
    const info = await this.resolve();
    return info.instanceUrl;
  }

  private async resolve(): Promise<CachedTokenInfo> {
    if (
      this.cached !== null &&
      this.now() - this.cached.fetchedAt < this.cached.ttlMs
    ) {
      return this.cached;
    }

    // OAuth 2.0 refresh-token grant. The body is form-encoded per RFC 6749
    // §4.3.2; secrets travel in the POST body, never the URL or logs.
    const tokenUrl = `${this.loginUrl}/services/oauth2/token`;
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: this.consumerKey,
      client_secret: this.consumerSecret,
      refresh_token: this.refreshToken,
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    let text: string;
    try {
      response = await this.fetchImpl(tokenUrl, {
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
          `Salesforce token request timed out after ${this.timeoutMs}ms`,
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
      // OAuth error bodies are `{ error, error_description }` — diagnostic
      // strings only, never token material; safe to surface in the hint.
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

    const accessToken = parsed.access_token;
    const instanceUrl = parsed.instance_url;
    if (typeof accessToken !== "string" || accessToken.length === 0) {
      throw new SalesforceError(
        "SF_AUTH_FAILED",
        "Salesforce token response contained no access_token",
      );
    }
    if (typeof instanceUrl !== "string" || instanceUrl.length === 0) {
      throw new SalesforceError(
        "SF_AUTH_FAILED",
        "Salesforce token response contained no instance_url",
      );
    }

    this.cached = {
      accessToken,
      instanceUrl,
      fetchedAt: this.now(),
      ttlMs: computeTtlMs(parsed.expires_in),
    };
    return this.cached;
  }
}

// Immutable #3 "refresh at 80% of TTL." Applies the 0.8 rule precisely when
// Salesforce returns `expires_in`; otherwise uses the documented conservative
// fallback (see FALLBACK_TOKEN_TTL_MS).
function computeTtlMs(expiresIn: unknown): number {
  if (
    typeof expiresIn === "number" &&
    Number.isFinite(expiresIn) &&
    expiresIn > 0
  ) {
    return Math.floor(expiresIn * 1000 * 0.8);
  }
  return FALLBACK_TOKEN_TTL_MS;
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
      return `Salesforce token endpoint rejected the request (HTTP ${status}, ${parsed.error}${desc})`;
    }
  } catch {
    // Non-JSON body — fall through to the status-only message.
  }
  return `Salesforce token endpoint returned HTTP ${status}`;
}

function requireValue(value: string | undefined, envName: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    // Env-var NAMES are not secrets (PF-09 records them publicly); naming the
    // missing one is a safe, actionable hint. Values never appear here.
    throw new SalesforceError(
      "SF_AUTH_FAILED",
      `${envName} is not set; the deployed BFF cannot authenticate to Salesforce`,
    );
  }
  return value;
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}
