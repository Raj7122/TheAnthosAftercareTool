// TR-OFFLINE-5a / Pattern E — Review Required state machine.
//
// Pure function: same (currentStatus, event) → same TransitionResult, no I/O,
// no side effects. The DB UPDATE lives in
// `packages/persistence/src/repositories/offline-queue.ts::applyQueueResolution`;
// callers (P3C-06 sync worker, P3C-07 resolve handler) translate the
// TransitionResult into the existing `ApplyQueueResolutionInput` columnar
// update.
//
// Source-of-truth for which transitions are legal — see Pattern E §"Implementation
// shape" + the transition matrix in the P3C-08 plan. Consumers MUST NOT
// re-implement transition rules (ticket AC).
//
// EC-46 stance: manual-only. A reverted caseload reassignment does NOT
// auto-clear `review_required_reassigned`; the specialist must tap
// REASSIGN_RETRY. Pattern E line 69 ("no fourth resolution path"; "don't
// auto-resolve") forecloses auto-resolution, and the machine has no CDC-event
// input today regardless. Revisit if EC-46 ever closes in favor of automation.

import { InvalidTransitionError } from "./errors.js";
import type {
  OfflineQueueStatus,
  ResolutionSource,
  TransitionEvent,
  TransitionResult,
} from "./types.js";

const TERMINAL_STATUSES: ReadonlySet<OfflineQueueStatus> = new Set([
  "completed",
  "discarded",
  "failed_max_retries",
]);

const REVIEW_REQUIRED_STATUSES: ReadonlySet<OfflineQueueStatus> = new Set([
  "review_required_reassigned",
  "review_required_terminated",
]);

export function applyTransition(
  currentStatus: OfflineQueueStatus,
  event: TransitionEvent,
): TransitionResult {
  if (TERMINAL_STATUSES.has(currentStatus)) {
    throw new InvalidTransitionError(
      "TRANSITION_FROM_TERMINAL_STATE",
      currentStatus,
      event,
      `Cannot transition from terminal state '${currentStatus}'`,
    );
  }

  switch (event.kind) {
    case "attempt_start":
      return handleAttemptStart(currentStatus, event);
    case "attempt_succeeded":
      return handleAttemptSucceeded(currentStatus, event);
    case "attempt_failed_transient":
      return handleAttemptFailedTransient(currentStatus, event);
    case "attempt_failed_lock_row":
      return handleAttemptFailedLockRow(currentStatus, event);
    case "attempt_failed_semantic":
      return handleAttemptFailedSemantic(currentStatus, event);
    case "resolve":
      return handleResolve(currentStatus, event);
  }
}

function handleAttemptStart(
  currentStatus: OfflineQueueStatus,
  event: TransitionEvent,
): TransitionResult {
  if (currentStatus !== "pending_sync") {
    throw eventNotAllowed(currentStatus, event);
  }
  return {
    nextStatus: "in_flight",
    retryCount: "noop",
    resolutionAction: null,
    resolutionSource: "system",
    payloadMutation: null,
    emitsEscalation: false,
  };
}

function handleAttemptSucceeded(
  currentStatus: OfflineQueueStatus,
  event: TransitionEvent,
): TransitionResult {
  if (currentStatus !== "in_flight") {
    throw eventNotAllowed(currentStatus, event);
  }
  return {
    nextStatus: "completed",
    retryCount: "noop",
    resolutionAction: null,
    resolutionSource: "system",
    payloadMutation: null,
    emitsEscalation: false,
  };
}

function handleAttemptFailedTransient(
  currentStatus: OfflineQueueStatus,
  event: TransitionEvent & { kind: "attempt_failed_transient" },
): TransitionResult {
  if (currentStatus !== "in_flight") {
    throw eventNotAllowed(currentStatus, event);
  }
  return failedRetryOrDeadLetter(event.retryBudgetExhausted, "auto_retry");
}

function handleAttemptFailedLockRow(
  currentStatus: OfflineQueueStatus,
  event: TransitionEvent & { kind: "attempt_failed_lock_row" },
): TransitionResult {
  if (currentStatus !== "in_flight") {
    throw eventNotAllowed(currentStatus, event);
  }
  return failedRetryOrDeadLetter(event.retryBudgetExhausted, "auto_lock_retry");
}

function failedRetryOrDeadLetter(
  retryBudgetExhausted: boolean,
  retrySource: Extract<ResolutionSource, "auto_retry" | "auto_lock_retry">,
): TransitionResult {
  if (retryBudgetExhausted) {
    return {
      nextStatus: "failed_max_retries",
      retryCount: "noop",
      resolutionAction: null,
      resolutionSource: "auto_max_retries",
      payloadMutation: null,
      emitsEscalation: false,
    };
  }
  return {
    nextStatus: "pending_sync",
    retryCount: "increment",
    resolutionAction: null,
    resolutionSource: retrySource,
    payloadMutation: null,
    emitsEscalation: false,
  };
}

function handleAttemptFailedSemantic(
  currentStatus: OfflineQueueStatus,
  event: TransitionEvent & { kind: "attempt_failed_semantic" },
): TransitionResult {
  if (currentStatus !== "in_flight") {
    throw eventNotAllowed(currentStatus, event);
  }
  // Pattern E line 67 — retry_count preserved on entry into Review Required.
  const nextStatus: OfflineQueueStatus =
    event.variant === "reassigned"
      ? "review_required_reassigned"
      : "review_required_terminated";
  return {
    nextStatus,
    retryCount: "noop",
    resolutionAction: null,
    resolutionSource: "system",
    payloadMutation: null,
    emitsEscalation: false,
  };
}

function handleResolve(
  currentStatus: OfflineQueueStatus,
  event: TransitionEvent & { kind: "resolve" },
): TransitionResult {
  if (!REVIEW_REQUIRED_STATUSES.has(currentStatus)) {
    throw eventNotAllowed(currentStatus, event);
  }

  switch (event.action) {
    case "DISCARD":
      return {
        nextStatus: "discarded",
        retryCount: "noop",
        resolutionAction: "DISCARD",
        resolutionSource: "specialist",
        payloadMutation: null,
        emitsEscalation: false,
      };
    case "REASSIGN_RETRY": {
      const newOwnerId = event.newOwnerId;
      if (newOwnerId === undefined || newOwnerId === "") {
        throw new InvalidTransitionError(
          "RESOLVE_REASSIGN_MISSING_OWNER",
          currentStatus,
          event,
          "REASSIGN_RETRY requires a non-empty newOwnerId",
        );
      }
      // EC-46 (manual-only stance): the specialist explicitly chose to retry
      // against a new owner. No auto-resolution edge exists; if the upstream
      // reassignment was later reverted, the specialist's REASSIGN_RETRY tap
      // is still the only way out of `review_required_reassigned`.
      return {
        nextStatus: "pending_sync",
        retryCount: "reset",
        resolutionAction: "REASSIGN_RETRY",
        resolutionSource: "specialist",
        payloadMutation: { newOwnerId },
        emitsEscalation: false,
      };
    }
    case "ESCALATE_TO_SUPERVISOR":
      // Next status is `discarded` as a placeholder until P4-01 wires the
      // supervisor_escalations INSERT. The caller MUST honor emitsEscalation
      // and create the escalation row (today: P3C-07 emits an
      // `escalation.created` audit row with the generated escalation_id;
      // P4-01 will add the table INSERT alongside).
      return {
        nextStatus: "discarded",
        retryCount: "noop",
        resolutionAction: "ESCALATE_TO_SUPERVISOR",
        resolutionSource: "specialist",
        payloadMutation: null,
        emitsEscalation: true,
      };
  }
}

function eventNotAllowed(
  currentStatus: OfflineQueueStatus,
  event: TransitionEvent,
): InvalidTransitionError {
  return new InvalidTransitionError(
    "TRANSITION_EVENT_NOT_ALLOWED_FROM_STATE",
    currentStatus,
    event,
    `Event '${event.kind}' is not allowed from state '${currentStatus}'`,
  );
}
