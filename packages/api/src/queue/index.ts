// Queue endpoints (E-17 GET /queue/pending; E-18 POST /queue/sync;
// E-19 POST /queue/:id/resolve; F-14). Public surface of the queue module
// — the handlers plus the wire-DTO types the SPA binds to. The pure-
// derivation helpers (`buildQueuePendingBody`, `buildQueueSyncBody`,
// `derivePayloadPreview`, `deriveSuggestedResolution`) are internal:
// imported within @anthos/api directly, not re-exported, since they're
// substrate-internal projection rules.

export { handleQueuePending } from "./get-queue-pending.js";
export type { QueuePendingHandlerOptions } from "./get-queue-pending.js";
export { handleQueueSync } from "./post-queue-sync.js";
export type { QueueSyncHandlerOptions } from "./post-queue-sync.js";
export {
  handleQueueResolve,
} from "./post-queue-resolve.js";
export type {
  QueueResolveHandlerOptions,
  QueueResolveRouteContext,
} from "./post-queue-resolve.js";
export type {
  QueuePendingBody,
  QueuePendingErrorDetails,
  QueuePendingItem,
  QueueResolveBody,
  QueueResolveEscalationBody,
  QueueResolveRequest,
  QueueResolveSuccessBody,
  QueueSyncBody,
} from "./dto.js";
