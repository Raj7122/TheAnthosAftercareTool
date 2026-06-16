// @vitest-environment happy-dom

// P3C-12 — F-14 indicator render gates.
//
// Asserts the chip is hidden during the four "quiet" states (loading,
// 401, 403, zero count) and visible only when the BFF reports ≥1 pending
// item for the calling SPECIALIST. Tapping the chip mounts the inspector.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OfflineQueueIndicator } from "../../app/_components/offline/OfflineQueueIndicator";

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

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("OfflineQueueIndicator — render gates", () => {
  it("renders null while the first fetch is in-flight", async () => {
    // A fetch that never resolves keeps status pinned at "loading".
    const fetchImpl = vi.fn(() => new Promise<Response>(() => {}));
    await act(async () => {
      root.render(<OfflineQueueIndicator fetchImpl={fetchImpl} />);
    });
    expect(container.querySelector('[data-testid="offline-queue-indicator"]')).toBeNull();
  });

  it("renders null on 401 (unauthenticated)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(401, { code: "UNAUTH" }));
    await act(async () => {
      root.render(<OfflineQueueIndicator fetchImpl={fetchImpl} />);
    });
    await flushMicrotasks();
    expect(container.querySelector('[data-testid="offline-queue-indicator"]')).toBeNull();
  });

  it("renders null on 403 (non-SPECIALIST)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(403, { code: "FORBIDDEN" }));
    await act(async () => {
      root.render(<OfflineQueueIndicator fetchImpl={fetchImpl} />);
    });
    await flushMicrotasks();
    expect(container.querySelector('[data-testid="offline-queue-indicator"]')).toBeNull();
  });

  it("renders null when queueDepth is zero", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        specialistId: "spec-1",
        items: [],
        counts: {},
        queueDepth: 0,
        maxQueueDepth: 100,
      }),
    );
    await act(async () => {
      root.render(<OfflineQueueIndicator fetchImpl={fetchImpl} />);
    });
    await flushMicrotasks();
    expect(container.querySelector('[data-testid="offline-queue-indicator"]')).toBeNull();
  });

  it("renders chip with count when queueDepth > 0", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        specialistId: "spec-1",
        items: [
          fakeItem("q-1"),
          fakeItem("q-2"),
          fakeItem("q-3"),
        ],
        counts: { review_required_reassigned: 3 },
        queueDepth: 3,
        maxQueueDepth: 100,
      }),
    );
    await act(async () => {
      root.render(<OfflineQueueIndicator fetchImpl={fetchImpl} />);
    });
    await flushMicrotasks();

    const chip = container.querySelector<HTMLButtonElement>(
      '[data-testid="offline-queue-indicator"]',
    );
    expect(chip).not.toBeNull();
    expect(chip!.textContent).toContain("3 pending");
    expect(chip!.getAttribute("aria-label")).toBe(
      "3 pending offline-queue items",
    );
    expect(chip!.getAttribute("aria-expanded")).toBe("false");
  });

  it("opens the inspector when tapped and closes via the Close button", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        specialistId: "spec-1",
        items: [fakeItem("q-1")],
        counts: { review_required_reassigned: 1 },
        queueDepth: 1,
        maxQueueDepth: 100,
      }),
    );
    await act(async () => {
      root.render(<OfflineQueueIndicator fetchImpl={fetchImpl} />);
    });
    await flushMicrotasks();

    const chip = container.querySelector<HTMLButtonElement>(
      '[data-testid="offline-queue-indicator"]',
    );
    expect(chip).not.toBeNull();

    await act(async () => {
      chip!.click();
    });

    expect(
      document.body.querySelector('[data-testid="action-sheet-shell"]'),
    ).not.toBeNull();
    expect(chip!.getAttribute("aria-expanded")).toBe("true");

    const close = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="offline-queue-inspector-close"]',
    );
    expect(close).not.toBeNull();
    await act(async () => {
      close!.click();
    });

    expect(
      document.body.querySelector('[data-testid="action-sheet-shell"]'),
    ).toBeNull();
  });
});

function fakeItem(queueItemId: string): Record<string, unknown> {
  return {
    queueItemId,
    participantId: null,
    actionType: "log_call",
    status: "review_required_reassigned",
    createdAt: "2026-05-27T00:00:00.000Z",
    lastAttemptAt: null,
    retryCount: 0,
    errorDetails: null,
    payloadPreview: { snippet: "test snippet" },
    resolutionOptions: ["DISCARD", "REASSIGN_RETRY", "ESCALATE_TO_SUPERVISOR"],
    suggestedResolution: null,
  };
}
