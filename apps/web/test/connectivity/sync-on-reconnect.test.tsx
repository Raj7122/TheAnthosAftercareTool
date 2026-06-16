// @vitest-environment happy-dom

// P3C-11 — SyncOnReconnect: AC-52 iframe-path trigger.
//
// Drives the `ConnectivityProvider` probe seam through the
// online → degraded → online transition and asserts:
//   * POST /api/v1/queue/sync fires once per recovery edge with a fresh
//     Idempotency-Key (UUID) and credentials: "include".
//   * One [anthos.sync_sla] log line per fetch outcome (success / 429 /
//     server_error / network_error). No PII in any field.
//   * The tablet PWA surface is inert: even if state somehow flips, no
//     fetch is attempted there (cross-surface isolation guard).
//   * Mount-time / no-transition renders do NOT trigger.

import { StrictMode, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SyncOnReconnect } from "../../app/_components/connectivity/SyncOnReconnect";
import { ConnectivityProvider } from "../../app/_lib/connectivity/context";

// React 19 + vitest harness — same flag pattern as the provider test.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let container: HTMLDivElement;
let root: Root;

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

function makeOkResponse(body: object = { itemsRemaining: 0 }): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
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
  vi.restoreAllMocks();
  Object.defineProperty(window, "top", { configurable: true, value: window });
  delete (navigator as unknown as Record<string, unknown>).serviceWorker;
});

describe("SyncOnReconnect — desktop iframe surface", () => {
  it("fires POST /api/v1/queue/sync on degraded → online recovery with a fresh Idempotency-Key", async () => {
    configureSurface("iframe");
    const fetchImpl = vi.fn().mockResolvedValue(makeOkResponse());
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    // Start with a failing probe — the first effect tick flips us to degraded.
    const failingProbe = vi.fn().mockResolvedValue(false);
    await act(async () => {
      root.render(
        <ConnectivityProvider probe={failingProbe}>
          <SyncOnReconnect fetchImpl={fetchImpl} />
        </ConnectivityProvider>,
      );
    });

    // Swap to a succeeding probe → provider tears down and re-mounts the
    // effect with the immediate probe, dispatching `heartbeat_ok` → "online".
    const succeedingProbe = vi.fn().mockResolvedValue(true);
    await act(async () => {
      root.render(
        <ConnectivityProvider probe={succeedingProbe}>
          <SyncOnReconnect fetchImpl={fetchImpl} />
        </ConnectivityProvider>,
      );
    });

    // Flush microtasks so the async IIFE inside the effect resolves.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("/api/v1/queue/sync");
    expect(init?.method).toBe("POST");
    expect(init?.credentials).toBe("include");
    const headers = init?.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["Idempotency-Key"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );

    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy.mock.calls[0]![0]).toBe(
      "[anthos.sync_sla] queue.sync_triggered_after_reconnect",
    );
    const fields = infoSpy.mock.calls[0]![1] as Record<string, unknown>;
    expect(fields.surface).toBe("iframe");
    expect(fields.outcome).toBe("success");
    expect(fields.status).toBe(200);
    expect(fields.items_remaining).toBe(0);
  });

  it("does NOT fire on initial mount when state is online", async () => {
    configureSurface("iframe");
    const fetchImpl = vi.fn().mockResolvedValue(makeOkResponse());
    const succeedingProbe = vi.fn().mockResolvedValue(true);

    await act(async () => {
      root.render(
        <ConnectivityProvider probe={succeedingProbe}>
          <SyncOnReconnect fetchImpl={fetchImpl} />
        </ConnectivityProvider>,
      );
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does NOT fire on online → degraded transitions", async () => {
    configureSurface("iframe");
    const fetchImpl = vi.fn().mockResolvedValue(makeOkResponse());
    const failingProbe = vi.fn().mockResolvedValue(false);

    await act(async () => {
      root.render(
        <ConnectivityProvider probe={failingProbe}>
          <SyncOnReconnect fetchImpl={fetchImpl} />
        </ConnectivityProvider>,
      );
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("logs outcome='rate_limited' on a 429 response", async () => {
    configureSurface("iframe");
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 429 }));
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    const failing = vi.fn().mockResolvedValue(false);
    await act(async () => {
      root.render(
        <ConnectivityProvider probe={failing}>
          <SyncOnReconnect fetchImpl={fetchImpl} />
        </ConnectivityProvider>,
      );
    });
    const succeeding = vi.fn().mockResolvedValue(true);
    await act(async () => {
      root.render(
        <ConnectivityProvider probe={succeeding}>
          <SyncOnReconnect fetchImpl={fetchImpl} />
        </ConnectivityProvider>,
      );
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const fields = infoSpy.mock.calls[0]![1] as Record<string, unknown>;
    expect(fields.outcome).toBe("rate_limited");
    expect(fields.status).toBe(429);
  });

  it("logs outcome='network_error' on a fetch rejection", async () => {
    configureSurface("iframe");
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("net down"));
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    const failing = vi.fn().mockResolvedValue(false);
    await act(async () => {
      root.render(
        <ConnectivityProvider probe={failing}>
          <SyncOnReconnect fetchImpl={fetchImpl} />
        </ConnectivityProvider>,
      );
    });
    const succeeding = vi.fn().mockResolvedValue(true);
    await act(async () => {
      root.render(
        <ConnectivityProvider probe={succeeding}>
          <SyncOnReconnect fetchImpl={fetchImpl} />
        </ConnectivityProvider>,
      );
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const fields = infoSpy.mock.calls[0]![1] as Record<string, unknown>;
    expect(fields.outcome).toBe("network_error");
    expect(fields.status).toBeUndefined();
  });

  it("logs outcome='server_error' on a 5xx response", async () => {
    configureSurface("iframe");
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response("err", { status: 503 }));
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    const failing = vi.fn().mockResolvedValue(false);
    await act(async () => {
      root.render(
        <ConnectivityProvider probe={failing}>
          <SyncOnReconnect fetchImpl={fetchImpl} />
        </ConnectivityProvider>,
      );
    });
    const succeeding = vi.fn().mockResolvedValue(true);
    await act(async () => {
      root.render(
        <ConnectivityProvider probe={succeeding}>
          <SyncOnReconnect fetchImpl={fetchImpl} />
        </ConnectivityProvider>,
      );
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const fields = infoSpy.mock.calls[0]![1] as Record<string, unknown>;
    expect(fields.outcome).toBe("server_error");
    expect(fields.status).toBe(503);
  });

  it("includes elapsed_ms_from_degraded_to_trigger when reconnecting from a real degraded period", async () => {
    configureSurface("iframe");
    const fetchImpl = vi.fn().mockResolvedValue(makeOkResponse());
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    // Inject a clock that advances 4321ms between the degraded stamp and
    // the reconnect stamp.
    let tick = 0;
    const ticks = [1_000, 5_321];
    const now = vi.fn((): number => ticks[tick++] ?? 5_321);

    const failing = vi.fn().mockResolvedValue(false);
    await act(async () => {
      root.render(
        <ConnectivityProvider probe={failing}>
          <SyncOnReconnect fetchImpl={fetchImpl} now={now} />
        </ConnectivityProvider>,
      );
    });
    const succeeding = vi.fn().mockResolvedValue(true);
    await act(async () => {
      root.render(
        <ConnectivityProvider probe={succeeding}>
          <SyncOnReconnect fetchImpl={fetchImpl} now={now} />
        </ConnectivityProvider>,
      );
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const fields = infoSpy.mock.calls[0]![1] as Record<string, unknown>;
    expect(fields.elapsed_ms_from_degraded_to_trigger).toBe(4_321);
  });

  it("logs outcome='aborted' when the effect cleanup aborts an in-flight fetch", async () => {
    configureSurface("iframe");
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    // A fetch that never resolves on its own — it rejects only when the
    // caller's AbortController fires. This isolates the abort path so we
    // can assert it deterministically.
    const fetchImpl = vi
      .fn()
      .mockImplementation((_url: string, init: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        });
      });

    const failing = vi.fn().mockResolvedValue(false);
    await act(async () => {
      root.render(
        <ConnectivityProvider probe={failing}>
          <SyncOnReconnect fetchImpl={fetchImpl} />
        </ConnectivityProvider>,
      );
    });
    const succeeding = vi.fn().mockResolvedValue(true);
    await act(async () => {
      root.render(
        <ConnectivityProvider probe={succeeding}>
          <SyncOnReconnect fetchImpl={fetchImpl} />
        </ConnectivityProvider>,
      );
    });
    // Fetch is in flight (the mock never resolves). Unmounting fires the
    // effect cleanup → controller.abort() → fetch rejects with AbortError.
    await act(async () => {
      root.unmount();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(infoSpy).toHaveBeenCalledTimes(1);
    const fields = infoSpy.mock.calls[0]![1] as Record<string, unknown>;
    expect(fields.outcome).toBe("aborted");
    expect(fields.status).toBeUndefined();
  });

  it("under StrictMode the double-effect on mount does not double-fire the trigger", async () => {
    configureSurface("iframe");
    const fetchImpl = vi.fn().mockResolvedValue(makeOkResponse());
    vi.spyOn(console, "info").mockImplementation(() => {});

    // The full failing → succeeding cycle, wrapped in StrictMode so the
    // initial-mount double-effect is exercised. Recovery still fires the
    // trigger exactly once — the previous-state ref is what guarantees
    // idempotency across the double-mount.
    const failing = vi.fn().mockResolvedValue(false);
    await act(async () => {
      root.render(
        <StrictMode>
          <ConnectivityProvider probe={failing}>
            <SyncOnReconnect fetchImpl={fetchImpl} />
          </ConnectivityProvider>
        </StrictMode>,
      );
    });
    const succeeding = vi.fn().mockResolvedValue(true);
    await act(async () => {
      root.render(
        <StrictMode>
          <ConnectivityProvider probe={succeeding}>
            <SyncOnReconnect fetchImpl={fetchImpl} />
          </ConnectivityProvider>
        </StrictMode>,
      );
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("SyncOnReconnect — tablet PWA surface (cross-surface isolation)", () => {
  it("is inert: no fetch, even when state-transition logic would have fired", async () => {
    configureSurface("top-level");
    const fetchImpl = vi.fn().mockResolvedValue(makeOkResponse());

    // On the tablet surface the provider pins state to "online" and never
    // dispatches; even if a hypothetical degraded → online happened, the
    // component's internal guard short-circuits.
    const probe = vi.fn();
    await act(async () => {
      root.render(
        <ConnectivityProvider probe={probe}>
          <SyncOnReconnect fetchImpl={fetchImpl} />
        </ConnectivityProvider>,
      );
    });
    await act(async () => {
      window.dispatchEvent(new Event("offline"));
    });
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
