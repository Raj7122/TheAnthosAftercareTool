// TR-OFFLINE-5a Review Required state-machine vocabulary, mirrored locally
// so `packages/domain/` stays I/O-free (no import from @anthos/persistence).
// The persistence layer (offline_queue.ts) exports the authoritative union;
// the parity test (test/offline-queue/parity.test.ts) imports both at test
// time and asserts set-equality so drift is caught at CI.

// The seven persistent states from ERD §6.3 / offline_queue CHECK constraint.
// Pattern E's transitional `auto_retry` / `auto_max_retries` edges are NOT
// persistent states — they surface here only as `ResolutionSource` values
// attached to a transition that lands on `pending_sync` or
// `failed_max_retries`.
export type OfflineQueueStatus =
  | "pending_sync"
  | "in_flight"
  | "completed"
  | "review_required_reassigned"
  | "review_required_terminated"
  | "failed_max_retries"
  | "discarded";

// The three resolution paths per Pattern E line 36–50. TR-OFFLINE-5a / BR-70
// fix this set at three — a fourth path is an anti-pattern (Pattern E line 69).
export type ResolutionAction =
  | "DISCARD"
  | "REASSIGN_RETRY"
  | "ESCALATE_TO_SUPERVISOR";

// Who / what applied the transition. Distinguishes human dispositions from
// auto-retry edges so post-pilot analytics can audit the auto-vs-human mix
// (`offline_queue.resolution_source` partial index, offline_queue.ts:86).
export type ResolutionSource =
  | "specialist"
  | "supervisor"
  | "system"
  | "auto_retry"
  | "auto_max_retries"
  | "auto_lock_retry";

// Discriminated-union input to applyTransition. Retry-budget exhaustion is
// supplied by the caller (P3C-09 computes it); the state machine consumes
// the decision, never recomputes it.
export type TransitionEvent =
  | { kind: "attempt_start" }
  | { kind: "attempt_succeeded" }
  | { kind: "attempt_failed_transient"; retryBudgetExhausted: boolean }
  | { kind: "attempt_failed_lock_row"; retryBudgetExhausted: boolean }
  | { kind: "attempt_failed_semantic"; variant: "reassigned" | "terminated" }
  | {
      kind: "resolve";
      action: ResolutionAction;
      // Required for REASSIGN_RETRY (Pattern E line 42 — payload.owner_id is
      // rewritten). Absent for DISCARD / ESCALATE_TO_SUPERVISOR.
      newOwnerId?: string;
    };

// Pure-data transition decision. The caller (P3C-06 sync worker / P3C-07
// resolve handler) translates this into the existing
// `ApplyQueueResolutionInput` columnar update at the persistence boundary.
export interface TransitionResult {
  readonly nextStatus: OfflineQueueStatus;
  // How retry_count must change. `reset` only on REASSIGN_RETRY (Pattern E
  // line 67: "Don't reset retry_count on entry into Review Required. Only
  // REASSIGN_RETRY resets it"). `increment` on transient + lock-row retries.
  // `noop` everywhere else.
  readonly retryCount: "reset" | "increment" | "noop";
  // Set when the transition is a specialist-driven resolution; null for the
  // attempt_* edges. `applyQueueResolution` writes this to
  // `offline_queue.resolution_action`.
  readonly resolutionAction: ResolutionAction | null;
  // Always set so the audit + offline_queue.resolution_source column can
  // attribute every state change.
  readonly resolutionSource: ResolutionSource;
  // Only set on REASSIGN_RETRY: caller merges this into the queued payload so
  // the next flush targets the correct specialist.
  readonly payloadMutation: { newOwnerId: string } | null;
  // True when the consumer must ALSO INSERT into supervisor_escalations
  // (P4-01 — placeholder). Today only true for
  // `resolve` + ESCALATE_TO_SUPERVISOR.
  readonly emitsEscalation: boolean;
}
