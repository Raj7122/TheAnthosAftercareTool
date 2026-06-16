// @vitest-environment happy-dom

// P3C-12 — F-14 inspector list + resolve-flow coverage.
//
// Asserts the three Pattern E resolve actions wire through correctly:
// DISCARD (no extra fields), REASSIGN_RETRY (reveals + sends newOwnerId,
// surfaces the BFF's 400 envelope on missing id), ESCALATE_TO_SUPERVISOR
// (no extra fields). Refresh-on-success is owned by the parent hook —
// here the inspector test asserts the `onResolve` callback is invoked
// with the request shape the BFF expects.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { QueueResolveRequest } from "@anthos/api";

import { OfflineQueueInspector } from "../../app/_components/offline/OfflineQueueInspector";
import type { ResolveOutcome } from "../../app/_lib/offline/queue-pending-client";

type ResolveFn = (input: {
  readonly queueItemId: string;
  readonly request: QueueResolveRequest;
}) => Promise<ResolveOutcome>;

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  vi.restoreAllMocks();
});

function fakeItem(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    queueItemId: "q-1",
    participantId: null,
    actionType: "log_call",
    status: "review_required_reassigned",
    createdAt: "2026-05-27T00:00:00.000Z",
    lastAttemptAt: null,
    retryCount: 0,
    errorDetails: null,
    payloadPreview: { snippet: "Outreach call summary" },
    resolutionOptions: ["DISCARD", "REASSIGN_RETRY", "ESCALATE_TO_SUPERVISOR"],
    suggestedResolution: null,
    ...overrides,
  };
}

function submit(form: HTMLFormElement): void {
  // Click the submit button — happy-dom dispatches a `submit` event on the
  // host form, which is what the row's onSubmit binds to.
  const submitBtn = form.querySelector<HTMLButtonElement>(
    '[data-testid="resolve-submit"]',
  );
  if (submitBtn === null) throw new Error("missing submit button");
  submitBtn.click();
}

// React's controlled-input wrapper tracks `.value` via a private setter —
// assigning `input.value = "x"` directly bypasses the tracker so onChange
// never fires. Use the native prototype setter and then dispatch a
// bubbling input event, the same trick used by react-testing-library.
function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  if (setter === undefined) {
    input.value = value;
  } else {
    setter.call(input, value);
  }
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("OfflineQueueInspector — list", () => {
  it("renders one row per item", async () => {
    const onResolve = vi.fn();
    const onClose = vi.fn();
    await act(async () => {
      root.render(
        <OfflineQueueInspector
          items={[
            fakeItem({ queueItemId: "q-1" }) as never,
            fakeItem({ queueItemId: "q-2" }) as never,
          ]}
          onClose={onClose}
          onResolve={onResolve}
        />,
      );
    });

    const rows = document.body.querySelectorAll(
      '[data-testid="offline-queue-item-row"]',
    );
    expect(rows.length).toBe(2);
  });

  it("renders an empty-state message when items is empty", async () => {
    await act(async () => {
      root.render(
        <OfflineQueueInspector
          items={[]}
          onClose={vi.fn()}
          onResolve={vi.fn()}
        />,
      );
    });
    expect(
      document.body.querySelector(
        '[data-testid="offline-queue-inspector-empty"]',
      ),
    ).not.toBeNull();
  });
});

describe("OfflineQueueInspector — resolve flows", () => {
  it("DISCARD: submits action only and triggers onResolve", async () => {
    const onResolve = vi.fn<ResolveFn>(async () => ({
      kind: "success" as const,
      body: {
        queueItemId: "q-1",
        status: "discarded" as const,
        resolvedAt: "2026-05-27T00:00:00Z",
        resolvedBy: "spec-1",
        resolutionSource: "specialist" as const,
      },
    }));

    await act(async () => {
      root.render(
        <OfflineQueueInspector
          items={[fakeItem({ queueItemId: "q-1" }) as never]}
          onClose={vi.fn()}
          onResolve={onResolve}
        />,
      );
    });

    // DISCARD is the first option per RESOLVE_ACTIONS — already selected
    // by default (suggestedResolution is null in the fixture).
    const form = document.body.querySelector<HTMLFormElement>(
      '[data-testid="offline-queue-item-row"]',
    );
    expect(form).not.toBeNull();
    await act(async () => {
      submit(form!);
    });

    expect(onResolve).toHaveBeenCalledTimes(1);
    expect(onResolve.mock.calls[0]![0]).toEqual({
      queueItemId: "q-1",
      request: { action: "DISCARD" },
    });
  });

  it("REASSIGN_RETRY: reveals owner input and sends newOwnerId", async () => {
    const onResolve = vi.fn<ResolveFn>(async () => ({
      kind: "success" as const,
      body: {
        queueItemId: "q-1",
        status: "completed" as const,
        resolvedAt: "2026-05-27T00:00:00Z",
        resolvedBy: "spec-1",
        resolutionSource: "specialist" as const,
      },
    }));

    await act(async () => {
      root.render(
        <OfflineQueueInspector
          items={[fakeItem({ queueItemId: "q-1" }) as never]}
          onClose={vi.fn()}
          onResolve={onResolve}
        />,
      );
    });

    const select = document.body.querySelector<HTMLSelectElement>(
      '[data-testid="resolve-action-select"]',
    )!;
    await act(async () => {
      select.value = "REASSIGN_RETRY";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });

    const ownerInput = document.body.querySelector<HTMLInputElement>(
      '[data-testid="new-owner-id-input"]',
    );
    expect(ownerInput).not.toBeNull();

    await act(async () => {
      setInputValue(ownerInput!, "0058K00000ABCDeQAO");
    });

    const form = document.body.querySelector<HTMLFormElement>(
      '[data-testid="offline-queue-item-row"]',
    )!;
    await act(async () => {
      submit(form);
    });

    expect(onResolve).toHaveBeenCalledTimes(1);
    expect(onResolve.mock.calls[0]![0]).toEqual({
      queueItemId: "q-1",
      request: {
        action: "REASSIGN_RETRY",
        newOwnerId: "0058K00000ABCDeQAO",
      },
    });
  });

  it("REASSIGN_RETRY: surfaces BFF 400 envelope inline", async () => {
    const onResolve = vi.fn<ResolveFn>(async () => ({
      kind: "failure" as const,
      failure: {
        code: "VALIDATION_FAILED",
        message: "newOwnerId is required when action is REASSIGN_RETRY",
        status: 400,
        field: "newOwnerId",
        traceId: null,
      },
    }));

    await act(async () => {
      root.render(
        <OfflineQueueInspector
          items={[fakeItem({ queueItemId: "q-1" }) as never]}
          onClose={vi.fn()}
          onResolve={onResolve}
        />,
      );
    });

    const select = document.body.querySelector<HTMLSelectElement>(
      '[data-testid="resolve-action-select"]',
    )!;
    await act(async () => {
      select.value = "REASSIGN_RETRY";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });

    // Submit without filling newOwnerId — backend would reject.
    const form = document.body.querySelector<HTMLFormElement>(
      '[data-testid="offline-queue-item-row"]',
    )!;
    await act(async () => {
      submit(form);
    });
    // Let the failure-state setter resolve.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const alert = document.body.querySelector<HTMLElement>(
      '[data-testid="resolve-error"]',
    );
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toContain("newOwnerId is required");
  });

  it("ESCALATE_TO_SUPERVISOR: submits action only", async () => {
    const onResolve = vi.fn<ResolveFn>(async () => ({
      kind: "success" as const,
      body: {
        queueItemId: "q-1",
        escalationId: "esc-1",
        status: "review_required_reassigned" as const,
        resolvedAt: "2026-05-27T00:00:00Z",
        resolvedBy: "spec-1",
        resolutionSource: "specialist" as const,
        supervisorNotified: true,
      },
    }));

    await act(async () => {
      root.render(
        <OfflineQueueInspector
          items={[fakeItem({ queueItemId: "q-1" }) as never]}
          onClose={vi.fn()}
          onResolve={onResolve}
        />,
      );
    });

    const select = document.body.querySelector<HTMLSelectElement>(
      '[data-testid="resolve-action-select"]',
    )!;
    await act(async () => {
      select.value = "ESCALATE_TO_SUPERVISOR";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });

    const form = document.body.querySelector<HTMLFormElement>(
      '[data-testid="offline-queue-item-row"]',
    )!;
    await act(async () => {
      submit(form);
    });

    expect(onResolve).toHaveBeenCalledWith({
      queueItemId: "q-1",
      request: { action: "ESCALATE_TO_SUPERVISOR" },
    });
  });

  it("disables Close while a resolve is in flight", async () => {
    let release: (() => void) | undefined;
    const onResolve = vi.fn<ResolveFn>(
      () =>
        new Promise<ResolveOutcome>((resolve) => {
          release = () =>
            resolve({
              kind: "success",
              body: {
                queueItemId: "q-1",
                status: "discarded",
                resolvedAt: "2026-05-27T00:00:00Z",
                resolvedBy: "spec-1",
                resolutionSource: "specialist",
              },
            });
        }),
    );

    await act(async () => {
      root.render(
        <OfflineQueueInspector
          items={[fakeItem({ queueItemId: "q-1" }) as never]}
          onClose={vi.fn()}
          onResolve={onResolve}
        />,
      );
    });

    const form = document.body.querySelector<HTMLFormElement>(
      '[data-testid="offline-queue-item-row"]',
    )!;
    await act(async () => {
      submit(form);
    });

    const close = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="offline-queue-inspector-close"]',
    );
    expect(close).not.toBeNull();
    expect(close!.disabled).toBe(true);

    await act(async () => {
      release?.();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(close!.disabled).toBe(false);
  });
});
