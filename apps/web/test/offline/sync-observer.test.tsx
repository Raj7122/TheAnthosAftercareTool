// @vitest-environment happy-dom

// P3C-11 — SyncObserver: AC-52 tablet-PWA observability.
//
// On the tablet PWA surface the observer listens for the `online` event
// AND the SW's `outbox.replay_started` message, computes the elapsed time
// between them, and logs a structured line. If 60s pass after `online`
// without a message AND the outbox had items waiting, it logs an SLA
// violation. On the desktop iframe surface the observer is inert.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SyncObserver, SLA_DEADLINE_MS } from "../../app/_components/offline/SyncObserver";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

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
  if (kind === "iframe") {
    Object.defineProperty(window, "top", {
      configurable: true,
      value: { fake: true } as unknown as Window,
    });
  } else {
    Object.defineProperty(window, "top", {
      configurable: true,
      value: window,
    });
  }
}

function postReplayStarted(at: number): void {
  swTarget.dispatchEvent(
    new MessageEvent("message", {
      data: { type: "outbox.replay_started", at },
    }),
  );
}

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
  vi.useRealTimers();
  vi.restoreAllMocks();
  Object.defineProperty(window, "top", { configurable: true, value: window });
  delete (navigator as unknown as Record<string, unknown>).serviceWorker;
});

describe("SyncObserver — tablet PWA surface", () => {
  it("logs replay_started with elapsed_ms_since_open after online → message", async () => {
    configureSurface("top-level");
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    // The first render's effect snapshots (0 → no window). The second
    // render's cleanup + new effect snapshots again (2 → page_mount window
    // opens at `ticks[0]`). The `online` dispatch opens a fresh window at
    // `ticks[1]`, replacing the mount window — that's the timestamp the
    // message's `elapsed_ms_since_open` is measured against (`ticks[2]`).
    let tick = 0;
    const ticks = [1_000, 1_250, 1_500];
    const now = vi.fn((): number => ticks[tick++] ?? 1_500);

    await act(async () => {
      root.render(
        <SyncObserver now={now} snapshotPendingCount={async () => 0} />,
      );
    });

    await act(async () => {
      root.render(
        <SyncObserver now={now} snapshotPendingCount={async () => 2} />,
      );
    });

    await act(async () => {
      window.dispatchEvent(new Event("online"));
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      postReplayStarted(99_999);
    });

    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy.mock.calls[0]![0]).toBe(
      "[anthos.sync_sla] outbox.replay_started",
    );
    const fields = infoSpy.mock.calls[0]![1] as Record<string, unknown>;
    expect(fields.surface).toBe("pwa");
    expect(fields.reason).toBe("online_event");
    expect(fields.items_at_open).toBe(2);
    expect(fields.elapsed_ms_since_open).toBe(250);
    expect(fields.sw_at).toBe(99_999);
  });

  it("does not open a window when online fires with zero pending items", async () => {
    configureSurface("top-level");
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.useFakeTimers();

    await act(async () => {
      root.render(<SyncObserver snapshotPendingCount={async () => 0} />);
    });

    await act(async () => {
      window.dispatchEvent(new Event("online"));
      await Promise.resolve();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SLA_DEADLINE_MS + 1_000);
    });

    expect(infoSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("emits sla_violation when 60s elapses without a replay_started message", async () => {
    configureSurface("top-level");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.useFakeTimers();

    await act(async () => {
      root.render(<SyncObserver snapshotPendingCount={async () => 3} />);
    });

    // Page-mount snapshot opens a window (count > 0).
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SLA_DEADLINE_MS);
    });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]![0]).toBe(
      "[anthos.sync_sla] outbox.sync_sla_violation",
    );
    const fields = warnSpy.mock.calls[0]![1] as Record<string, unknown>;
    expect(fields.reason).toBe("page_mount");
    expect(fields.items_at_open).toBe(3);
    expect(fields.elapsed_ms_since_open).toBe(SLA_DEADLINE_MS);
  });

  it("opens a window at page mount when outbox is already populated", async () => {
    configureSurface("top-level");
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    let tick = 0;
    const ticks = [500, 1_500];
    const now = vi.fn((): number => ticks[tick++] ?? 1_500);

    await act(async () => {
      root.render(
        <SyncObserver now={now} snapshotPendingCount={async () => 1} />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      postReplayStarted(2_000);
    });

    expect(infoSpy).toHaveBeenCalledTimes(1);
    const fields = infoSpy.mock.calls[0]![1] as Record<string, unknown>;
    expect(fields.reason).toBe("page_mount");
    expect(fields.elapsed_ms_since_open).toBe(1_000);
  });

  it("a second online event replaces the window so only one SLA violation can fire", async () => {
    configureSurface("top-level");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.useFakeTimers();

    await act(async () => {
      root.render(<SyncObserver snapshotPendingCount={async () => 2} />);
    });

    // First online opens a window.
    await act(async () => {
      window.dispatchEvent(new Event("online"));
      await Promise.resolve();
    });
    // After 40s, a second online opens a fresh window — should reset.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(40_000);
      window.dispatchEvent(new Event("online"));
      await Promise.resolve();
    });
    // 50s after the second open (90s after the first) — only the second
    // window's timer should be live, and it has not yet expired.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50_000);
    });
    expect(warnSpy).not.toHaveBeenCalled();

    // 10s more → second window crosses 60s.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("logs replay_started with no elapsed_ms when no window is open", async () => {
    // The SW can fire `sync` at startup before the page sees an `online`
    // event — log the message anyway, omit the elapsed field.
    configureSurface("top-level");
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    await act(async () => {
      root.render(<SyncObserver snapshotPendingCount={async () => 0} />);
      await Promise.resolve();
    });

    await act(async () => {
      postReplayStarted(123_456);
    });

    expect(infoSpy).toHaveBeenCalledTimes(1);
    const fields = infoSpy.mock.calls[0]![1] as Record<string, unknown>;
    expect(fields.elapsed_ms_since_open).toBeUndefined();
    expect(fields.items_at_open).toBeUndefined();
    expect(fields.sw_at).toBe(123_456);
  });
});

describe("SyncObserver — desktop iframe surface (cross-surface isolation)", () => {
  it("attaches no listeners and emits no logs", async () => {
    configureSurface("iframe");
    const snapshot = vi.fn().mockResolvedValue(5);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.useFakeTimers();

    await act(async () => {
      root.render(<SyncObserver snapshotPendingCount={snapshot} />);
      await Promise.resolve();
    });

    await act(async () => {
      window.dispatchEvent(new Event("online"));
      postReplayStarted(1);
      await vi.advanceTimersByTimeAsync(SLA_DEADLINE_MS + 1_000);
    });

    expect(snapshot).not.toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
