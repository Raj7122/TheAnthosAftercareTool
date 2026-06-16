// Pattern D — BFF idempotency middleware. Public surface of the idempotency
// module. The Postgres store is intentionally NOT re-exported here: it is
// reached only via dynamic import, keeping the DB connection side effect out
// of the static import graph of @anthos/api.

export { withIdempotency } from "./middleware.js";
export type {
  IdempotentHandler,
  IdempotentRequestContext,
  RequestContext,
  WithIdempotencyOptions,
} from "./middleware.js";
export type {
  AcquireLockInput,
  IdempotencyRecord,
  IdempotencyStatus,
  IdempotencyStore,
} from "./store.js";
export { runIdempotencyCleanup } from "./cleanup.js";
export { canonicalJson, computeRequestHash } from "./request-hash.js";
