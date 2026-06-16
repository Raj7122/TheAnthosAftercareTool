// @anthos/api/auth — HTTP wiring for the auth cluster: the GET /api/v1/auth/login
// (E-01), GET /api/v1/auth/callback (E-02), POST /api/v1/auth/refresh (E-03),
// and POST /api/v1/auth/logout (E-04) handlers, their env-config loaders, and
// the error-response helpers. The Next.js route handlers in `apps/web` wire to
// `handleAuthLogin` / `handleAuthCallback` / `handleAuthRefresh` /
// `handleAuthLogout`.

export { handleAuthLogin } from "./login.js";
export type { AuthLoginOptions } from "./login.js";

export { handleAuthCallback } from "./callback.js";
export type {
  AuthCallbackOptions,
  ResolvedSpecialist,
  SpecialistResolver,
} from "./callback.js";

export { handleAuthRefresh } from "./refresh.js";
export type { AuthRefreshOptions, RefreshTokenExchanger } from "./refresh.js";

export { handleAuthLogout } from "./logout.js";
export type { AuthLogoutOptions } from "./logout.js";

export { handleMe, ME_FEATURE_FLAG_KEYS } from "./me.js";
export type { AuthMeOptions, FirstRunLookup } from "./me.js";

export { RETURN_TO_MAX_LENGTH, RETURN_TO_PATTERN, validateReturnTo } from "./return-to.js";
export type { ReturnToResult } from "./return-to.js";

export {
  DEFAULT_OAUTH_COOKIE_MAX_AGE_SECONDS,
  DEFAULT_OAUTH_COOKIE_SAMESITE,
  DEFAULT_OAUTH_SCOPE,
  ENV_OAUTH_COOKIE_SAMESITE,
  ENV_OAUTH_COOKIE_SECRET,
  ENV_OAUTH_COOKIE_SECURE,
  ENV_OAUTH_REDIRECT_URI,
  ENV_OAUTH_SCOPE,
  ENV_SF_CLIENT_ID,
  ENV_SF_LOGIN_URL,
  loadOAuthLoginConfig,
} from "./config.js";
export type { OAuthLoginConfig } from "./config.js";

export {
  ENV_ROLE_PERMISSION_SETS,
  ENV_SF_CLIENT_SECRET,
  ENV_SF_TOKEN_ENC_KEY,
  loadAuthCallbackConfig,
  resolveSessionCookieAttributes,
} from "./callback-config.js";
export type { AuthCallbackConfig } from "./callback-config.js";

export { loadAuthRefreshConfig } from "./refresh-config.js";
export type { AuthRefreshConfig } from "./refresh-config.js";

export { loadAuthLogoutConfig } from "./logout-config.js";
export type { AuthLogoutConfig } from "./logout-config.js";

export { authErrorResponse, authRedirectFailure } from "./responses.js";
export type {
  AuthCallbackErrorCode,
  AuthErrorCode,
  InvalidQueryParamDetails,
} from "./responses.js";
