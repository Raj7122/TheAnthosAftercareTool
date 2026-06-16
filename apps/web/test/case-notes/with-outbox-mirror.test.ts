// P3C-14 — the Log Case Note Outbox mirror wrapper. Confirms it targets the
// `/case-notes` endpoint with the right body and delegates the lifecycle to the
// generic core (enqueue-before-fire, keep-on-network-error, drop-on-rejection).

import { describe, expect, it, vi } from "vitest";

import type { CreateCaseNoteInput } from "../../app/_components/case-notes/types";
import type { MutationFailure } from "../../app/caseload/_lib/send-mutation";
import type { QueuedAction } from "../../app/_lib/offline/types";
import type { OutboxMirrorDeps } from "../../app/_lib/offline/outbox-mirror";
import {
  reconcileCaseNoteWithOutboxMirror,
  toCaseNoteRequestBody,
} from "../../app/_lib/case-notes/with-outbox-mirror";

const INPUT: CreateCaseNoteInput = {
  note: "Quarterly stability check",
  contactType: "In Person",
  type: "Stability Meeting",
  status: "Completed",
};

function makeAction(idempotencyKey: string): QueuedAction {
  return {
    id: idempotencyKey,
    endpoint: "/api/v1/participants/p-1/case-notes",
    method: "POST",
    body: toCaseNoteRequestBody(INPUT),
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

describe("toCaseNoteRequestBody", () => {
  it("routes the four SF fields verbatim", () => {
    expect(toCaseNoteRequestBody(INPUT)).toEqual({
      note: "Quarterly stability check",
      contactType: "In Person",
      type: "Stability Meeting",
      status: "Completed",
    });
  });
});

describe("reconcileCaseNoteWithOutboxMirror", () => {
  it("enqueues ONCE before reconcile against the /case-notes endpoint with the same key", async () => {
    const deps = makeDeps();
    const reconcile = vi.fn(async (): Promise<MutationFailure | null> => null);
    await reconcileCaseNoteWithOutboxMirror(deps, "p-1", "key-1", INPUT, reconcile);

    expect(deps.enqueue).toHaveBeenCalledTimes(1);
    expect(deps.enqueue).toHaveBeenCalledWith({
      endpoint: "/api/v1/participants/p-1/case-notes",
      method: "POST",
      body: toCaseNoteRequestBody(INPUT),
      idempotencyKey: "key-1",
    });
    expect(deps.enqueue.mock.invocationCallOrder[0]).toBeLessThan(
      reconcile.mock.invocationCallOrder[0]!,
    );
  });

  it("flashes synced on a confirmed write", async () => {
    const deps = makeDeps();
    const result = await reconcileCaseNoteWithOutboxMirror(
      deps,
      "p-1",
      "key-1",
      INPUT,
      async () => null,
    );
    expect(result).toBeNull();
    expect(deps.markSynced).toHaveBeenCalledTimes(1);
    expect(deps.discard).not.toHaveBeenCalled();
  });

  it("leaves the mirror queued on a network failure", async () => {
    const deps = makeDeps();
    const failure = networkFailure();
    const result = await reconcileCaseNoteWithOutboxMirror(
      deps,
      "p-1",
      "key-1",
      INPUT,
      async () => failure,
    );
    expect(result).toBe(failure);
    expect(deps.markSynced).not.toHaveBeenCalled();
    expect(deps.discard).not.toHaveBeenCalled();
  });

  it("URL-encodes the participant id in the endpoint", async () => {
    const deps = makeDeps();
    await reconcileCaseNoteWithOutboxMirror(
      deps,
      "p/1",
      "key-1",
      INPUT,
      async () => null,
    );
    expect(deps.enqueue.mock.calls[0]![0].endpoint).toBe(
      "/api/v1/participants/p%2F1/case-notes",
    );
  });
});
