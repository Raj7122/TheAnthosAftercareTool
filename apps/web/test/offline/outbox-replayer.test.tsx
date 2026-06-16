// @vitest-environment happy-dom

// P3C — OutboxReplayer trigger wiring, focused on the poll-while-pending
// fallback. The browser `online` event is unreliably delivered on real
// wifi/airplane-mode toggles (and absent on iPad Safari, which has no
// Background Sync API), so the replayer also polls while the Outbox holds
// rows: each tick re-attempts the drain when `navigator.onLine` is true. This
// suite asserts ONLY that the poll fires (and is gated/started/stopped/cleaned
// up) — `replay.test.ts` already covers the drain's inFlight + idempotency.
//
// The Outbox module is mocked (not fake-indexeddb) so the queue contents are a
// deterministic in-memory value that plays cleanly with fake timers, and the
// `replay` prop seam stands in for `replayOutbox` so no fetch/IDB is touched.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockOutbox = vi.hoisted(() => {
  const state = {
    rows: [] as ReadonlyArray<{ id: string }>,
    listeners: new Set<() => void>(),
  };
  const list = async (): Promise<ReadonlyArray<{ id: string }>> => [...state.rows];
  const subscribeOutbox = (listener: () => void): (() => void) => {
    state.listeners.add(listener);
    return () => {
      state.listeners.delete(listener);
    };
  };
  // Test driver: set the queued-row count and fan out a change notification,
  // exactly as enqueue/remove/clearAll do via notifyOutboxChanged.
  const setRows = (count: number): void => {
    state.rows = Array.from({ length: count }, (_, i) => ({ id: `row-${i}` }));
    for (const listener of state.listeners) listener();
  };
  return { state, list, subscribeOutbox, setRows };
});

vi.mock("../../app/_lib/offline/outbox", () => ({
  list: mockOutbox.list,
  subscribeOutbox: mockOutbox.subscribeOutbox,
}));

import { OutboxReplayer } from "../../app/_components/offline/OutboxReplayer";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const POLL_MS = 1_000;

let container: HTMLDivElement;
let root: Root;
let swTarget: EventTarget;

function configureSurface(kind: "iframe" | "top-level"): void {
  swTarget = new EventTarget();
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: {
      addEventListener: swTarget.addEventListener.bind(swTarget),
      removeEventListener: swTarget.removeEventListener.bind(swTarget),
      dispatchEvent: swTarget.dispatchEvent.bind(swTarget),
    } as unknown as ServiceWorkerContainer,
  });
  Object.defineProperty(window, "top", {
    configurable: true,
    value: kind === "iframe" ? ({ fake: true } as unknown as Window) : window,
  });
}

function setOnline(online: boolean): void {
  Object.defineProperty(navigator, "onLine", {
    configurable: true,
    value: online,
  });
}

// Render the replayer with the poll-fallback interval and a `replay` spy,
// flushing the mount-time async list() reads so the poll is wired before the
// test advances timers.
async function mount(replay: () => void): Promise<void> {
  await act(async () => {
    root.render(<OutboxReplayer replay={replay} pollIntervalMs={POLL_MS} />);
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.useFakeTimers();
  setOnline(true);
  mockOutbox.state.rows = [];
  mockOutbox.state.listeners.clear();
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  setOnline(true);
  mockOutbox.state.rows = [];
  mockOutbox.state.listeners.clear();
  Object.defineProperty(window, "top", { configurable: true, value: window });
  delete (navigator as unknown as Record<string, unknown>).serviceWorker;
});

describe("OutboxReplayer — poll-while-pending fallback (tablet PWA)", () => {
  it("drains via the poll when no `online` event ever fires", async () => {
    configureSurface("top-level");
    mockOutbox.setRows(1);
    const replay = vi.fn();

    await mount(replay);
    // Mount-time drain runs once (online + rows queued).
    const atMount = replay.mock.calls.length;
    expect(atMount).toBe(1);

    // No `online` event is dispatched — only the poll keeps retrying.
    await advance(POLL_MS);
    expect(replay).toHaveBeenCalledTimes(atMount + 1);
    await advance(POLL_MS);
    expect(replay).toHaveBeenCalledTimes(atMount + 2);
  });

  it("does not replay on a tick while offline, then replays once reconnected", async () => {
    configureSurface("top-level");
    setOnline(false);
    mockOutbox.setRows(1);
    const replay = vi.fn();

    await mount(replay);
    // Offline at mount: the mount-time drain is gated out.
    expect(replay).not.toHaveBeenCalled();

    // Ticks fire but are gated by navigator.onLine — no failed POSTs queued.
    await advance(POLL_MS * 3);
    expect(replay).not.toHaveBeenCalled();

    // Connectivity returns WITHOUT an `online` event (the failure mode this
    // fallback exists for) — the next tick drains.
    setOnline(true);
    await advance(POLL_MS);
    expect(replay).toHaveBeenCalledTimes(1);
  });

  it("stops polling once the Outbox drains", async () => {
    configureSurface("top-level");
    mockOutbox.setRows(1);
    const replay = vi.fn();

    await mount(replay);
    await advance(POLL_MS);
    expect(replay.mock.calls.length).toBeGreaterThan(0);

    // The queue empties (e.g. a confirmed write's remove()); the change
    // notification stops the interval.
    await act(async () => {
      mockOutbox.setRows(0);
      await Promise.resolve();
      await Promise.resolve();
    });
    const afterDrain = replay.mock.calls.length;

    await advance(POLL_MS * 3);
    expect(replay).toHaveBeenCalledTimes(afterDrain);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never polls when the Outbox is empty at mount", async () => {
    configureSurface("top-level");
    const replay = vi.fn();

    await mount(replay);
    await advance(POLL_MS * 5);

    expect(replay).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("runs a single interval despite repeated change notifications", async () => {
    configureSurface("top-level");
    mockOutbox.setRows(1);
    const replay = vi.fn();

    await mount(replay);
    const atMount = replay.mock.calls.length;

    // Several enqueue-style notifications while already pending must not stack
    // intervals — startPolling is guarded.
    await act(async () => {
      mockOutbox.setRows(1);
      mockOutbox.setRows(1);
      mockOutbox.setRows(1);
      await Promise.resolve();
      await Promise.resolve();
    });

    // One interval elapsed → exactly one tick, not one-per-notification.
    await advance(POLL_MS);
    expect(replay).toHaveBeenCalledTimes(atMount + 1);
  });

  it("clears the interval on unmount", async () => {
    configureSurface("top-level");
    mockOutbox.setRows(1);
    const replay = vi.fn();

    await mount(replay);
    await advance(POLL_MS);
    const beforeUnmount = replay.mock.calls.length;

    act(() => {
      root.unmount();
    });

    await advance(POLL_MS * 3);
    expect(replay).toHaveBeenCalledTimes(beforeUnmount);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("OutboxReplayer — desktop iframe surface (cross-surface isolation)", () => {
  it("never polls on the iframe surface even with rows queued", async () => {
    configureSurface("iframe");
    mockOutbox.setRows(1);
    const replay = vi.fn();

    await mount(replay);
    await advance(POLL_MS * 5);

    expect(replay).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
