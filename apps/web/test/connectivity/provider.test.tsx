// @vitest-environment happy-dom

// P3C-03 — `ConnectivityProvider` integration: drives state transitions via
// the probe seam + window events on the desktop iframe surface, and verifies
// the cross-surface isolation chokepoint (no probe, no listeners on the
// tablet PWA surface where `isTopLevelOriginSurface()` is true).
//
// Asserts the TR-OFFLINE-2 asymmetric-recovery rule end-to-end: the browser's
// `online` event MUST NOT clear the banner; only a successful `/healthz`
// response can.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ConnectivityProvider,
  useConnectivity,
} from "../../app/_lib/connectivity/context";
import type { ConnectivityState } from "../../app/_lib/connectivity/state-machine";

// React 19 in a vitest environment expects this flag so `act()` warnings
// don't fire and updates flush synchronously inside `act` blocks.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let container: HTMLDivElement;
let root: Root;

function Probe() {
  const state = useConnectivity();
  return <span data-testid="state">{state}</span>;
}

function readState(): ConnectivityState {
  const el = container.querySelector<HTMLElement>('[data-testid="state"]');
  if (el === null) throw new Error("state probe not in DOM");
  return el.textContent as ConnectivityState;
}

// `isTopLevelOriginSurface()` returns true only when `window.self === window.top`
// (default in happy-dom) AND `"serviceWorker" in navigator` (NOT default).
function configureSurface(kind: "iframe" | "top-level"): void {
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: {} as ServiceWorkerContainer,
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
  // Restore the surface stubs across tests.
  Object.defineProperty(window, "top", { configurable: true, value: window });
  delete (navigator as unknown as Record<string, unknown>).serviceWorker;
});

describe("ConnectivityProvider — desktop iframe surface", () => {
  it("starts optimistically online, then flips to degraded on first failed probe", async () => {
    configureSurface("iframe");
    const probe = vi.fn().mockResolvedValue(false);

    await act(async () => {
      root.render(
        <ConnectivityProvider probe={probe}>
          <Probe />
        </ConnectivityProvider>,
      );
    });

    // The initial probe fires immediately on mount; one tick later state
    // reflects the resolved result.
    expect(probe).toHaveBeenCalledTimes(1);
    expect(readState()).toBe("degraded");
  });

  it("clears the degraded state on the next successful probe (recovery via heartbeat_ok)", async () => {
    configureSurface("iframe");

    // First render with a failing probe → state flips to degraded.
    const failingProbe = vi.fn().mockResolvedValue(false);
    await act(async () => {
      root.render(
        <ConnectivityProvider probe={failingProbe}>
          <Probe />
        </ConnectivityProvider>,
      );
    });
    expect(readState()).toBe("degraded");

    // Swap to a succeeding probe via prop change. The provider's
    // `useEffect([probe])` tears the old interval/listeners down and starts
    // fresh — including the immediate first probe — so this exercises the
    // recovery path without burning a real 5s timer in the test.
    const succeedingProbe = vi.fn().mockResolvedValue(true);
    await act(async () => {
      root.render(
        <ConnectivityProvider probe={succeedingProbe}>
          <Probe />
        </ConnectivityProvider>,
      );
    });

    expect(succeedingProbe).toHaveBeenCalledTimes(1);
    expect(readState()).toBe("online");
  });

  it("ignores the browser `online` event while degraded (asymmetric recovery)", async () => {
    configureSurface("iframe");
    const probe = vi.fn().mockResolvedValue(false);

    await act(async () => {
      root.render(
        <ConnectivityProvider probe={probe}>
          <Probe />
        </ConnectivityProvider>,
      );
    });
    expect(readState()).toBe("degraded");

    // The browser's `online` event can fire while the BFF stays unreachable.
    // TR-OFFLINE-2 forbids us from lifting the banner on this signal alone.
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });

    expect(readState()).toBe("degraded");
  });

  it("flips to degraded immediately on a browser `offline` event", async () => {
    configureSurface("iframe");
    // Probe resolves "ok" indefinitely — so a state flip can ONLY come from
    // the window `offline` event in this test.
    const probe = vi.fn().mockResolvedValue(true);

    await act(async () => {
      root.render(
        <ConnectivityProvider probe={probe}>
          <Probe />
        </ConnectivityProvider>,
      );
    });
    expect(readState()).toBe("online");

    await act(async () => {
      window.dispatchEvent(new Event("offline"));
    });
    expect(readState()).toBe("degraded");
  });
});

describe("ConnectivityProvider — tablet PWA surface (cross-surface isolation)", () => {
  it("does NOT fire the probe when the surface is top-level (tablet PWA)", async () => {
    configureSurface("top-level");
    const probe = vi.fn().mockResolvedValue(false);

    await act(async () => {
      root.render(
        <ConnectivityProvider probe={probe}>
          <Probe />
        </ConnectivityProvider>,
      );
    });

    // The provider's `useEffect` short-circuits on the tablet PWA surface —
    // P3C-01's SW + IndexedDB Outbox owns offline UX there, not /healthz.
    expect(probe).not.toHaveBeenCalled();
    // State stays at its initial "online" so the banner renders nothing.
    expect(readState()).toBe("online");
  });

  it("does NOT degrade on `offline` events when the surface is top-level", async () => {
    configureSurface("top-level");
    const probe = vi.fn();

    await act(async () => {
      root.render(
        <ConnectivityProvider probe={probe}>
          <Probe />
        </ConnectivityProvider>,
      );
    });

    await act(async () => {
      window.dispatchEvent(new Event("offline"));
    });

    // No listener registered → no state change.
    expect(readState()).toBe("online");
    expect(probe).not.toHaveBeenCalled();
  });
});
