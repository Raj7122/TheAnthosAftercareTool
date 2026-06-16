// Session middleware (ADR-03 / ARC-13 / F-01). Public surface of the session
// module. The Postgres store is intentionally NOT re-exported: it is reached
// only via dynamic import, keeping the DB connection side effect out of the
// static import graph of @anthos/api.

export { withSession } from "./middleware.js";
export type {
  SessionHandler,
  SessionRequestContext,
  WithSessionOptions,
} from "./middleware.js";

export type { CreateSessionInput, SessionRecord, SessionStore } from "./store.js";

export { sessionErrorResponse } from "./responses.js";
export type { SessionErrorCode, SessionErrorDetails } from "./responses.js";

export { refreshSession, revokeSession, startSession } from "./service.js";
export type {
  RefreshSessionOptions,
  StartedSession,
  StartSessionInput,
} from "./service.js";
