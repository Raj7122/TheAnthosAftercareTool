// @vitest-environment happy-dom

// P3C-14 — the Log Case Note reconciler hook. Asserts the surface-gated
// behavior: mirror OFF (desktop iframe) calls createCaseNote directly; mirror
// ON (tablet PWA) enqueues to the Outbox with the SAME key, flashes synced on a
// confirmed write, swallows NETWORK_ERROR to null (offline-first: the note is
// safely queued), and discards on a server rejection. The I/O leaves (mutation,
// Outbox, replay) are mocked so this is a focused unit test.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CreateCaseNoteInput } from "../../app/_components/case-notes/types";
import type { CreateCaseNoteResult } from "../../app/_components/case-notes/useCaseNoteMutation";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const createCaseNoteImpl = vi.fn(
  async (
    _pid: string,
    _input: CreateCaseNoteInput,
    _key?: string,
  ): Promise<CreateCaseNoteResult> => ({
    outcome: "success",
    record: {
      caseNoteId: "cn-1",
      participantId: "p-1",
      serviceDate: "2026-06-07",
      note: "n",
      contactType: "Phone",
      type: "Check In",
      status: "Completed",
      loggedAt: "2026-06-07T00:00:00Z",
    },
  }),
);
const enqueueMock = vi.fn(async (input: { idempotencyKey?: string }) => ({
  id: input.idempotencyKey ?? "minted",
  endpoint: "/api/v1/participants/p-1/case-notes",
  method: "POST" as const,
  body: {},
  idempotencyKey: input.idempotencyKey ?? "minted",
  enqueuedAt: 1,
  retryCount: 0,
  state: "pending_sync" as const,
}));
const removeMock = vi.fn(async (_id: string) => {});
const flashSyncedMock = vi.fn(async (_row: unknown) => {});

vi.mock("../../app/_components/case-notes/useCaseNoteMutation", () => ({
  useCaseNoteMutation: () => ({
    isPending: false,
    createCaseNote: createCaseNoteImpl,
  }),
}));
vi.mock("../../app/_lib/offline/outbox", () => ({
  enqueue: (i: { idempotencyKey?: string }) => enqueueMock(i),
  remove: (id: string) => removeMock(id),
}));
vi.mock("../../app/_lib/offline/replay", () => ({
  flashSynced: (row: unknown) => flashSyncedMock(row),
}));

const { useCaseNoteReconciler } = await import(
  "../../app/_lib/case-notes/use-case-note-reconciler"
);
type Reconcile = ReturnType<typeof useCaseNoteReconciler>["reconcileCaseNote"];

const INPUT: CreateCaseNoteInput = {
  note: "Quarterly stability check",
  contactType: "In Person",
  type: "Stability Meeting",
  status: "Completed",
};

let container: HTMLDivElement;
let root: Root;
let reconcile: Reconcile;

function mount(outboxMirror: boolean): void {
  function Harness() {
    ({ reconcileCaseNote: reconcile } = useCaseNoteReconciler({ outboxMirror }));
    return null;
  }
  act(() => {
    root.render(<Harness />);
  });
}

beforeEach(() => {
  createCaseNoteImpl.mockClear();
  enqueueMock.mockClear();
  removeMock.mockClear();
  flashSyncedMock.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("useCaseNoteReconciler — mirror OFF (desktop iframe)", () => {
  it("calls createCaseNote directly and returns null on success", async () => {
    mount(false);
    let result: unknown;
    await act(async () => {
      result = await reconcile("p-1", "key-1", INPUT);
    });
    expect(result).toBeNull();
    expect(createCaseNoteImpl).toHaveBeenCalledWith("p-1", INPUT, "key-1");
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("returns the failure on a server rejection", async () => {
    const failure = {
      code: "VALIDATION_FAILED",
      message: "Note required.",
      traceId: "t-1",
      field: "note",
      reason: null,
    };
    createCaseNoteImpl.mockResolvedValueOnce({ outcome: "failure", failure });
    mount(false);
    let result: unknown;
    await act(async () => {
      result = await reconcile("p-1", "key-1", INPUT);
    });
    expect(result).toBe(failure);
    expect(enqueueMock).not.toHaveBeenCalled();
  });
});

describe("useCaseNoteReconciler — mirror ON (tablet PWA)", () => {
  it("enqueues with the SAME key and flashes synced on a confirmed write", async () => {
    mount(true);
    let result: unknown;
    await act(async () => {
      result = await reconcile("p-1", "key-1", INPUT);
    });
    expect(result).toBeNull();
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    expect(enqueueMock.mock.calls[0]![0].idempotencyKey).toBe("key-1");
    // Same key threads to the mutation (Pattern D dedupe across replay).
    expect(createCaseNoteImpl).toHaveBeenCalledWith("p-1", INPUT, "key-1");
    expect(flashSyncedMock).toHaveBeenCalledTimes(1);
    expect(removeMock).not.toHaveBeenCalled();
  });

  it("swallows NETWORK_ERROR to null and leaves the row queued (offline-first)", async () => {
    createCaseNoteImpl.mockResolvedValueOnce({
      outcome: "failure",
      failure: {
        code: "NETWORK_ERROR",
        message: "Network error.",
        traceId: null,
        field: null,
        reason: null,
      },
    });
    mount(true);
    let result: unknown;
    await act(async () => {
      result = await reconcile("p-1", "key-1", INPUT);
    });
    // null → the sheet closes; the row stays in the Outbox for the replay.
    expect(result).toBeNull();
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    expect(flashSyncedMock).not.toHaveBeenCalled();
    expect(removeMock).not.toHaveBeenCalled();
  });

  it("discards the row and surfaces a genuine server rejection", async () => {
    const failure = {
      code: "VALIDATION_FAILED",
      message: "Note required.",
      traceId: "t-1",
      field: "note",
      reason: null,
    };
    createCaseNoteImpl.mockResolvedValueOnce({ outcome: "failure", failure });
    mount(true);
    let result: unknown;
    await act(async () => {
      result = await reconcile("p-1", "key-1", INPUT);
    });
    expect(result).toBe(failure);
    expect(removeMock).toHaveBeenCalledWith("key-1");
    expect(flashSyncedMock).not.toHaveBeenCalled();
  });
});
