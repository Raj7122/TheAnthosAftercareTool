// @vitest-environment happy-dom

// P3C-03 — `/healthz` probe behavior on the desktop iframe heartbeat
// (TR-OFFLINE-2, 5-second cadence). The asymmetric recovery rule lives in
// the reducer (state-machine.test.ts); this file covers the I/O boundary:
// what counts as a successful heartbeat?

import { afterEach, describe, expect, it, vi } from "vitest";

import { PROBE_TIMEOUT_MS, probeHealthz } from "../../app/_lib/connectivity/probe";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("probeHealthz", () => {
  it("returns true on a 2xx response", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    expect(await probeHealthz()).toBe(true);
    expect(fetch).toHaveBeenCalledWith(
      "/healthz",
      expect.objectContaining({
        method: "GET",
        cache: "no-store",
        credentials: "omit",
      }),
    );
  });

  it("returns false on a 5xx response (process up but not healthy)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 503 })),
    );
    expect(await probeHealthz()).toBe(false);
  });

  it("returns false on network rejection (TypeError, DNS failure, etc.)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("network reject")),
    );
    expect(await probeHealthz()).toBe(false);
  });

  it("returns false when the request is aborted via an external signal", async () => {
    // Simulate the provider's unmount path: the caller's controller fires
    // while the fetch is in flight, so the local probe controller aborts.
    const fetch = vi.fn().mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        }),
    );
    vi.stubGlobal("fetch", fetch);
    const external = new AbortController();
    const promise = probeHealthz(external.signal);
    external.abort();
    expect(await promise).toBe(false);
  });

  it("returns false on timeout (hung connection counts as failed heartbeat)", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        }),
    );
    vi.stubGlobal("fetch", fetch);

    const probePromise = probeHealthz();
    // Advance past the internal timeout — controller.abort() fires, the
    // mocked fetch's listener rejects, and probeHealthz returns false.
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS + 50);
    expect(await probePromise).toBe(false);
  });
});
