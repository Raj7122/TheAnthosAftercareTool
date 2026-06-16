// P3C-13 — the enqueue-on-submit seam (Pattern C/D). The Outbox mirror must
// be written ONCE before the reconcile fires, carrying the same idempotency
// key; removed on a confirmed write; LEFT queued on a network failure (so the
// reconnect replay re-sends it); and removed on a server rejection (replaying
// a doomed request would only duplicate the failure).

import { describe, expect, it, vi } from "vitest";

import type { LogCallInput } from "../../app/caseload/_lib/useLogCallMutation";
import type { MutationFailure } from "../../app/caseload/_lib/send-mutation";
import type { QueuedAction } from "../../app/_lib/offline/types";
import {
  reconcileWithOutboxMirror,
  toLogCallRequestBody,
  type OutboxMirrorDeps,
} from "../../app/_lib/log-call/with-outbox-mirror";

function makeAction(idempotencyKey: string): QueuedAction {
  return {
    id: idempotencyKey,
    endpoint: "/api/v1/participants/p-1/calls",
    method: "POST",
    body: { status: "Completed" },
    idempotencyKey,
    enqueuedAt: 1,
    retryCount: 0,
    state: "pending_sync",
  };
}

const INPUT = {
  status: "Completed",
  type: "Check In",
  serviceDate: "2026-05-31",
  summary: "Spoke with participant.",
} as LogCallInput;

function networkFailure(): MutationFailure {
  return {
    code: "NETWORK_ERROR",
    message: "Network error.",
    traceId: null,
    field: null,
    reason: null,
  };
}

function validationFailure(): MutationFailure {
  return {
    code: "VALIDATION_FAILED",
    message: "Summary required.",
    traceId: "t-1",
    field: "summary",
    reason: null,
  };
}

function makeDeps(
  reconcileResult: MutationFailure | null,
): OutboxMirrorDeps & {
  enqueue: ReturnType<typeof vi.fn>;
  markSynced: ReturnType<typeof vi.fn>;
  discard: ReturnType<typeof vi.fn>;
  reconcile: ReturnType<typeof vi.fn>;
} {
  return {
    enqueue: vi.fn(async (input: { idempotencyKey?: string }) =>
      makeAction(input.idempotencyKey ?? "minted"),
    ),
    markSynced: vi.fn(async () => {}),
    discard: vi.fn(async () => {}),
    reconcile: vi.fn(async () => reconcileResult),
  };
}

describe("reconcileWithOutboxMirror", () => {
  it("enqueues ONCE before reconcile, with the same key + POST body", async () => {
    const deps = makeDeps(null);
    await reconcileWithOutboxMirror(deps, "p-1", "key-1", INPUT);

    expect(deps.enqueue).toHaveBeenCalledTimes(1);
    expect(deps.enqueue).toHaveBeenCalledWith({
      endpoint: "/api/v1/participants/p-1/calls",
      method: "POST",
      body: toLogCallRequestBody(INPUT),
      idempotencyKey: "key-1",
    });
    // enqueue resolved before reconcile was invoked.
    expect(deps.enqueue.mock.invocationCallOrder[0]).toBeLessThan(
      deps.reconcile.mock.invocationCallOrder[0]!,
    );
  });

  it("flashes synced (removes + checkmark) on a confirmed write", async () => {
    const deps = makeDeps(null);
    const result = await reconcileWithOutboxMirror(deps, "p-1", "key-1", INPUT);
    expect(result).toBeNull();
    expect(deps.markSynced).toHaveBeenCalledTimes(1);
    expect(deps.markSynced.mock.calls[0]![0].id).toBe("key-1");
    expect(deps.discard).not.toHaveBeenCalled();
  });

  it("leaves the mirror queued on a network failure", async () => {
    const failure = networkFailure();
    const deps = makeDeps(failure);
    const result = await reconcileWithOutboxMirror(deps, "p-1", "key-1", INPUT);
    expect(result).toBe(failure);
    expect(deps.markSynced).not.toHaveBeenCalled();
    expect(deps.discard).not.toHaveBeenCalled();
  });

  it("discards the mirror (no checkmark) on a server rejection (4xx)", async () => {
    const failure = validationFailure();
    const deps = makeDeps(failure);
    const result = await reconcileWithOutboxMirror(deps, "p-1", "key-1", INPUT);
    expect(result).toBe(failure);
    expect(deps.discard).toHaveBeenCalledWith("key-1");
    expect(deps.markSynced).not.toHaveBeenCalled();
  });

  it("does not multiply enqueues across the reconciler's internal retries", async () => {
    // The reconciler owns its own retry loop inside one `reconcile` call; the
    // mirror enqueues exactly once regardless.
    const deps = makeDeps(null);
    await reconcileWithOutboxMirror(deps, "p-1", "key-1", INPUT);
    expect(deps.enqueue).toHaveBeenCalledTimes(1);
    expect(deps.reconcile).toHaveBeenCalledTimes(1);
  });
});
