// P3C-14 — the generic Outbox-mirror core. Enqueue ONCE before the reconcile
// (same key); remove + flash on a confirmed write; LEAVE queued on a network
// failure (reconnect replay re-sends it); drop on a server rejection.

import { describe, expect, it, vi } from "vitest";

import type { MutationFailure } from "../../app/caseload/_lib/send-mutation";
import type { QueuedAction } from "../../app/_lib/offline/types";
import {
  runWithOutboxMirror,
  type OutboxMirrorDeps,
} from "../../app/_lib/offline/outbox-mirror";

function makeAction(idempotencyKey: string): QueuedAction {
  return {
    id: idempotencyKey,
    endpoint: "/api/v1/participants/p-1/case-notes",
    method: "POST",
    body: { note: "n" },
    idempotencyKey,
    enqueuedAt: 1,
    retryCount: 0,
    state: "pending_sync",
  };
}

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
    message: "Note required.",
    traceId: "t-1",
    field: "note",
    reason: null,
  };
}

function makeDeps(): OutboxMirrorDeps & {
  enqueue: ReturnType<typeof vi.fn>;
  markSynced: ReturnType<typeof vi.fn>;
  discard: ReturnType<typeof vi.fn>;
} {
  return {
    enqueue: vi.fn(async (input: { idempotencyKey?: string }) =>
      makeAction(input.idempotencyKey ?? "minted"),
    ),
    markSynced: vi.fn(async () => {}),
    discard: vi.fn(async () => {}),
  };
}

const ENDPOINT = "/api/v1/participants/p-1/case-notes";
const BODY = { note: "Quarterly check" };

describe("runWithOutboxMirror", () => {
  it("enqueues ONCE before the reconcile, with the passed endpoint/body/key", async () => {
    const deps = makeDeps();
    const reconcile = vi.fn(async (): Promise<MutationFailure | null> => null);
    await runWithOutboxMirror(deps, ENDPOINT, "POST", BODY, "key-1", reconcile);

    expect(deps.enqueue).toHaveBeenCalledTimes(1);
    expect(deps.enqueue).toHaveBeenCalledWith({
      endpoint: ENDPOINT,
      method: "POST",
      body: BODY,
      idempotencyKey: "key-1",
    });
    expect(deps.enqueue.mock.invocationCallOrder[0]).toBeLessThan(
      reconcile.mock.invocationCallOrder[0]!,
    );
  });

  it("removes + flashes synced on a confirmed write", async () => {
    const deps = makeDeps();
    const result = await runWithOutboxMirror(
      deps,
      ENDPOINT,
      "POST",
      BODY,
      "key-1",
      async () => null,
    );
    expect(result).toBeNull();
    expect(deps.markSynced).toHaveBeenCalledTimes(1);
    expect(deps.markSynced.mock.calls[0]![0].id).toBe("key-1");
    expect(deps.discard).not.toHaveBeenCalled();
  });

  it("leaves the mirror queued on a network failure", async () => {
    const deps = makeDeps();
    const failure = networkFailure();
    const result = await runWithOutboxMirror(
      deps,
      ENDPOINT,
      "POST",
      BODY,
      "key-1",
      async () => failure,
    );
    expect(result).toBe(failure);
    expect(deps.markSynced).not.toHaveBeenCalled();
    expect(deps.discard).not.toHaveBeenCalled();
  });

  it("discards the mirror on a server rejection", async () => {
    const deps = makeDeps();
    const failure = validationFailure();
    const result = await runWithOutboxMirror(
      deps,
      ENDPOINT,
      "POST",
      BODY,
      "key-1",
      async () => failure,
    );
    expect(result).toBe(failure);
    expect(deps.discard).toHaveBeenCalledWith("key-1");
    expect(deps.markSynced).not.toHaveBeenCalled();
  });
});
