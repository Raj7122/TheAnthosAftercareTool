// Builder for the Salesforce OAuth authorize URL (RFC 6749 §4.1.1 + RFC 7636).
// GET /api/v1/auth/login (E-01) 302-redirects the browser here. Pure: every
// value is passed in — no env reads, no I/O.
import { PKCE_CHALLENGE_METHOD } from "./pkce.js";

export interface AuthorizeUrlParams {
  // `SF_LOGIN_URL` — the Salesforce login origin (TR-AUTH-1, per environment).
  readonly loginUrl: string;
  // `SF_CONNECTED_APP_CONSUMER_KEY` — the Connected App's OAuth `client_id`.
  readonly clientId: string;
  // `SF_OAUTH_REDIRECT_URI` — absolute /api/v1/auth/callback URL (E-02).
  readonly redirectUri: string;
  // base64url(SHA-256(code_verifier)).
  readonly codeChallenge: string;
  // CSRF `state` — the random value also persisted in `anthos_oauth_state`.
  readonly state: string;
  // Space-delimited OAuth scope tokens (e.g. "api refresh_token"). NOT the
  // Connected App object permissions — see TR-AUTH-2 / BR-01.
  readonly scope: string;
}

// Build `${loginUrl}/services/oauth2/authorize?…` with `response_type=code`,
// `code_challenge_method=S256`, and every param URL-encoded via URLSearchParams.
export function buildAuthorizeUrl(params: AuthorizeUrlParams): string {
  const base = `${stripTrailingSlash(params.loginUrl)}/services/oauth2/authorize`;
  const query = new URLSearchParams({
    response_type: "code",
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    code_challenge: params.codeChallenge,
    code_challenge_method: PKCE_CHALLENGE_METHOD,
    state: params.state,
    scope: params.scope,
  });
  return `${base}?${query.toString()}`;
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}
