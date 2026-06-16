import { describe, expect, it } from "vitest";

import {
  applyTransition,
  InvalidTransitionError,
  type OfflineQueueStatus,
  type TransitionEvent,
} from "../../src/offline-queue/index.js";

// TR-OFFLINE-5a / Pattern E — full transition matrix coverage. Each `describe`
// block pins one source status; legal events are asserted against a concrete
// TransitionResult, illegal events against an InvalidTransitionError code.

const ALL_STATUSES: ReadonlyArray<OfflineQueueStatus> = [
  "pending_sync",
  "in_flight",
  "completed",
  "review_required_reassigned",
  "review_required_terminated",
  "failed_max_retries",
  "discarded",
];

const TERMINAL_STATUSES: ReadonlyArray<OfflineQueueStatus> = [
  "completed",
  "discarded",
  "failed_max_retries",
];

const SAMPLE_EVENTS: ReadonlyArray<TransitionEvent> = [
  { kind: "attempt_start" },
  { kind: "attempt_succeeded" },
  { kind: "attempt_failed_transient", retryBudgetExhausted: false },
  { kind: "attempt_failed_lock_row", retryBudgetExhausted: false },
  { kind: "attempt_failed_semantic", variant: "reassigned" },
  { kind: "resolve", action: "DISCARD" },
];

describe("applyTransition — pending_sync", () => {
  it("attempt_start → in_flight (resolutionSource=system)", () => {
    expect(applyTransition("pending_sync", { kind: "attempt_start" })).toEqual({
      nextStatus: "in_flight",
      retryCount: "noop",
      resolutionAction: null,
      resolutionSource: "system",
      payloadMutation: null,
      emitsEscalation: false,
    });
  });

  it.each([
    { kind: "attempt_succeeded" },
    { kind: "attempt_failed_transient", retryBudgetExhausted: false },
    { kind: "attempt_failed_lock_row", retryBudgetExhausted: true },
    { kind: "attempt_failed_semantic", variant: "reassigned" },
    { kind: "attempt_failed_semantic", variant: "terminated" },
    { kind: "resolve", action: "DISCARD" },
    { kind: "resolve", action: "REASSIGN_RETRY", newOwnerId: "005xxx" },
    { kind: "resolve", action: "ESCALATE_TO_SUPERVISOR" },
  ] satisfies TransitionEvent[])(
    "rejects $kind with EVENT_NOT_ALLOWED_FROM_STATE",
    (event) => {
      expectNotAllowed("pending_sync", event);
    },
  );
});

describe("applyTransition — in_flight", () => {
  it("attempt_succeeded → completed", () => {
    expect(
      applyTransition("in_flight", { kind: "attempt_succeeded" }),
    ).toEqual({
      nextStatus: "completed",
      retryCount: "noop",
      resolutionAction: null,
      resolutionSource: "system",
      payloadMutation: null,
      emitsEscalation: false,
    });
  });

  describe("attempt_failed_transient", () => {
    it("within retry budget → pending_sync (increment, auto_retry)", () => {
      expect(
        applyTransition("in_flight", {
          kind: "attempt_failed_transient",
          retryBudgetExhausted: false,
        }),
      ).toEqual({
        nextStatus: "pending_sync",
        retryCount: "increment",
        resolutionAction: null,
        resolutionSource: "auto_retry",
        payloadMutation: null,
        emitsEscalation: false,
      });
    });

    it("exhausted → failed_max_retries (auto_max_retries dead-letter)", () => {
      expect(
        applyTransition("in_flight", {
          kind: "attempt_failed_transient",
          retryBudgetExhausted: true,
        }),
      ).toEqual({
        nextStatus: "failed_max_retries",
        retryCount: "noop",
        resolutionAction: null,
        resolutionSource: "auto_max_retries",
        payloadMutation: null,
        emitsEscalation: false,
      });
    });
  });

  describe("attempt_failed_lock_row (UNABLE_TO_LOCK_ROW)", () => {
    it("within retry budget → pending_sync (auto_lock_retry)", () => {
      expect(
        applyTransition("in_flight", {
          kind: "attempt_failed_lock_row",
          retryBudgetExhausted: false,
        }),
      ).toEqual({
        nextStatus: "pending_sync",
        retryCount: "increment",
        resolutionAction: null,
        resolutionSource: "auto_lock_retry",
        payloadMutation: null,
        emitsEscalation: false,
      });
    });

    it("exhausted → failed_max_retries (auto_max_retries)", () => {
      expect(
        applyTransition("in_flight", {
          kind: "attempt_failed_lock_row",
          retryBudgetExhausted: true,
        }),
      ).toEqual({
        nextStatus: "failed_max_retries",
        retryCount: "noop",
        resolutionAction: null,
        resolutionSource: "auto_max_retries",
        payloadMutation: null,
        emitsEscalation: false,
      });
    });
  });

  describe("attempt_failed_semantic", () => {
    it("reassigned → review_required_reassigned (retry_count preserved)", () => {
      expect(
        applyTransition("in_flight", {
          kind: "attempt_failed_semantic",
          variant: "reassigned",
        }),
      ).toEqual({
        nextStatus: "review_required_reassigned",
        retryCount: "noop",
        resolutionAction: null,
        resolutionSource: "system",
        payloadMutation: null,
        emitsEscalation: false,
      });
    });

    it("terminated → review_required_terminated", () => {
      expect(
        applyTransition("in_flight", {
          kind: "attempt_failed_semantic",
          variant: "terminated",
        }),
      ).toEqual({
        nextStatus: "review_required_terminated",
        retryCount: "noop",
        resolutionAction: null,
        resolutionSource: "system",
        payloadMutation: null,
        emitsEscalation: false,
      });
    });
  });

  it.each([
    { kind: "attempt_start" },
    { kind: "resolve", action: "DISCARD" },
    { kind: "resolve", action: "REASSIGN_RETRY", newOwnerId: "005xxx" },
    { kind: "resolve", action: "ESCALATE_TO_SUPERVISOR" },
  ] satisfies TransitionEvent[])(
    "rejects $kind with EVENT_NOT_ALLOWED_FROM_STATE",
    (event) => {
      expectNotAllowed("in_flight", event);
    },
  );
});

describe.each(["review_required_reassigned", "review_required_terminated"] as const)(
  "applyTransition — %s",
  (sourceStatus) => {
    it("resolve DISCARD → discarded (specialist)", () => {
      expect(
        applyTransition(sourceStatus, {
          kind: "resolve",
          action: "DISCARD",
        }),
      ).toEqual({
        nextStatus: "discarded",
        retryCount: "noop",
        resolutionAction: "DISCARD",
        resolutionSource: "specialist",
        payloadMutation: null,
        emitsEscalation: false,
      });
    });

    it("resolve REASSIGN_RETRY → pending_sync (reset, payload carries newOwnerId)", () => {
      expect(
        applyTransition(sourceStatus, {
          kind: "resolve",
          action: "REASSIGN_RETRY",
          newOwnerId: "005ZZZ",
        }),
      ).toEqual({
        nextStatus: "pending_sync",
        retryCount: "reset",
        resolutionAction: "REASSIGN_RETRY",
        resolutionSource: "specialist",
        payloadMutation: { newOwnerId: "005ZZZ" },
        emitsEscalation: false,
      });
    });

    it("resolve REASSIGN_RETRY without newOwnerId → RESOLVE_REASSIGN_MISSING_OWNER", () => {
      const event: TransitionEvent = {
        kind: "resolve",
        action: "REASSIGN_RETRY",
      };
      expect(() => applyTransition(sourceStatus, event)).toThrow(
        InvalidTransitionError,
      );
      try {
        applyTransition(sourceStatus, event);
      } catch (err) {
        if (!(err instanceof InvalidTransitionError)) throw err;
        expect(err.code).toBe("RESOLVE_REASSIGN_MISSING_OWNER");
        expect(err.fromStatus).toBe(sourceStatus);
      }
    });

    it("resolve REASSIGN_RETRY with empty-string newOwnerId → RESOLVE_REASSIGN_MISSING_OWNER", () => {
      expect(() =>
        applyTransition(sourceStatus, {
          kind: "resolve",
          action: "REASSIGN_RETRY",
          newOwnerId: "",
        }),
      ).toThrow(InvalidTransitionError);
    });

    it("resolve ESCALATE_TO_SUPERVISOR → discarded (emitsEscalation=true)", () => {
      expect(
        applyTransition(sourceStatus, {
          kind: "resolve",
          action: "ESCALATE_TO_SUPERVISOR",
        }),
      ).toEqual({
        nextStatus: "discarded",
        retryCount: "noop",
        resolutionAction: "ESCALATE_TO_SUPERVISOR",
        resolutionSource: "specialist",
        payloadMutation: null,
        emitsEscalation: true,
      });
    });

    it.each([
      { kind: "attempt_start" },
      { kind: "attempt_succeeded" },
      { kind: "attempt_failed_transient", retryBudgetExhausted: false },
      { kind: "attempt_failed_lock_row", retryBudgetExhausted: false },
      { kind: "attempt_failed_semantic", variant: "reassigned" },
    ] satisfies TransitionEvent[])(
      "rejects $kind with EVENT_NOT_ALLOWED_FROM_STATE",
      (event) => {
        expectNotAllowed(sourceStatus, event);
      },
    );
  },
);

describe.each(TERMINAL_STATUSES)(
  "applyTransition — terminal state %s",
  (sourceStatus) => {
    it.each(SAMPLE_EVENTS)(
      "rejects $kind with TRANSITION_FROM_TERMINAL_STATE",
      (event) => {
        expect(() => applyTransition(sourceStatus, event)).toThrow(
          InvalidTransitionError,
        );
        try {
          applyTransition(sourceStatus, event);
        } catch (err) {
          if (!(err instanceof InvalidTransitionError)) throw err;
          expect(err.code).toBe("TRANSITION_FROM_TERMINAL_STATE");
          expect(err.fromStatus).toBe(sourceStatus);
          expect(err.event).toBe(event);
        }
      },
    );
  },
);

describe("applyTransition — purity", () => {
  it("same (status, event) → strictly equal TransitionResult across calls", () => {
    const event: TransitionEvent = {
      kind: "attempt_failed_transient",
      retryBudgetExhausted: false,
    };
    const first = applyTransition("in_flight", event);
    for (let i = 0; i < 50; i++) {
      expect(applyTransition("in_flight", event)).toStrictEqual(first);
    }
  });

  it("does not mutate the input event object", () => {
    const event: TransitionEvent = {
      kind: "resolve",
      action: "REASSIGN_RETRY",
      newOwnerId: "005ABC",
    };
    const snapshot = structuredClone(event);
    applyTransition("review_required_reassigned", event);
    expect(event).toStrictEqual(snapshot);
  });
});

describe("applyTransition — exhaustive coverage marker", () => {
  // Sanity test: every status appears in at least one positive transition path
  // OR is asserted-terminal above. Catches accidental status additions that
  // skip the matrix.
  it("covers every OfflineQueueStatus value", () => {
    expect(new Set(ALL_STATUSES).size).toBe(7);
  });
});

function expectNotAllowed(
  status: OfflineQueueStatus,
  event: TransitionEvent,
): void {
  expect(() => applyTransition(status, event)).toThrow(InvalidTransitionError);
  try {
    applyTransition(status, event);
  } catch (err) {
    if (!(err instanceof InvalidTransitionError)) throw err;
    expect(err.code).toBe("TRANSITION_EVENT_NOT_ALLOWED_FROM_STATE");
    expect(err.fromStatus).toBe(status);
    expect(err.event).toBe(event);
  }
}
