// Origin-header CSRF validation (API §8.6 / SEC-THREAT-1 / TR-AUTH-5). Public
// surface of the origin module — composed into every mutation endpoint.

export {
  DEFAULT_ALLOWED_ORIGINS,
  ENV_ALLOWED_ORIGINS,
  loadOriginConfig,
} from "./config.js";
export type { OriginConfig } from "./config.js";
export { isOriginAllowed, isSafeMethod, sanitizeOriginForAudit } from "./validate.js";
export { CSRF_ORIGIN_MISMATCH, csrfOriginMismatchResponse } from "./responses.js";
export { enforceOrigin } from "./guard.js";
export type { EnforceOriginDeps } from "./guard.js";
