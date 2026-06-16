// Typed errors thrown by applyTransition. Fail-loud: an illegal
// `(fromStatus, event)` pair is a programmer bug, not a runtime condition the
// caller can recover from. Mirrors the ConfigValidationError / FactorTypeError
// idiom in `packages/domain/src/priority/errors.ts`.

import type { OfflineQueueStatus, TransitionEvent } from "./types.js";

export class InvalidTransitionError extends Error {
  override readonly name = "InvalidTransitionError";
  readonly code:
    // Terminal states (`completed`, `discarded`, `failed_max_retries`) accept
    // no further events.
    | "TRANSITION_FROM_TERMINAL_STATE"
    // The source state was non-terminal but the event isn't legal from it
    // (e.g. `attempt_succeeded` from `pending_sync` — must `attempt_start`
    // first; `resolve` from `in_flight` — must reach a `review_required_*`
    // state first).
    | "TRANSITION_EVENT_NOT_ALLOWED_FROM_STATE"
    // REASSIGN_RETRY without a newOwnerId. Surfaces what was previously a
    // silent null write at post-queue-resolve.ts:401 as a typed precondition
    // failure the handler converts to a 400.
    | "RESOLVE_REASSIGN_MISSING_OWNER";
  readonly fromStatus: OfflineQueueStatus;
  readonly event: TransitionEvent;

  constructor(
    code: InvalidTransitionError["code"],
    fromStatus: OfflineQueueStatus,
    event: TransitionEvent,
    message: string,
  ) {
    super(message);
    this.code = code;
    this.fromStatus = fromStatus;
    this.event = event;
  }
}
