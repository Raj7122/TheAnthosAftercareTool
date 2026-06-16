// @anthos/auth/oauth — pure OAuth Authorization Code + PKCE primitives for the
// Salesforce login flow (F-01, P1B-01): PKCE generation, CSRF `state`, AES-256-
// GCM cookie encryption, encrypted-cookie serialization, and the authorize-URL
// builder. I/O-free; feature code imports from the `@anthos/auth` barrel.

export {
  deriveCodeChallenge,
  generatePkcePair,
  isValidCodeVerifier,
  PKCE_CHALLENGE_METHOD,
  PKCE_VERIFIER_MAX_LENGTH,
  PKCE_VERIFIER_MIN_LENGTH,
} from "./pkce.js";
export type { PkcePair } from "./pkce.js";

export { generateOAuthState, OAUTH_STATE_BYTES } from "./state.js";

export {
  aeadDecrypt,
  aeadEncrypt,
  AEAD_IV_BYTES,
  AEAD_KEY_BYTES,
  AEAD_TAG_BYTES,
  decodeCookieKey,
} from "./crypto.js";

export {
  clearOAuthPkceCookie,
  clearOAuthStateCookie,
  decodePkcePayload,
  decodeStatePayload,
  encodePkcePayload,
  encodeStatePayload,
  OAUTH_PKCE_COOKIE_NAME,
  OAUTH_STATE_COOKIE_NAME,
  readOAuthCookie,
  serializeOAuthPkceCookie,
  serializeOAuthStateCookie,
} from "./cookies.js";
export type { OAuthCookieAttributes, OAuthPkcePayload, OAuthStatePayload } from "./cookies.js";

export { buildAuthorizeUrl } from "./authorize-url.js";
export type { AuthorizeUrlParams } from "./authorize-url.js";
