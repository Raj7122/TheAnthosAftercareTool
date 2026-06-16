// @vitest-environment happy-dom

// P3C-01 — registerOfflineServiceWorker() iframe-and-support guard.
// The PF-05 spike outcome makes a regression here a way to silently ship SW
// registration into the desktop iframe surface. Each test holds one variant
// of the guard matrix.

import { afterEach, describe, expect, it, vi } from "vitest";

import { registerOfflineServiceWorker } from "../../app/_lib/offline/register-sw";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  // happy-dom's serviceWorker stubs leak across tests if we don't reset.
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: undefined,
  });
  delete (navigator as unknown as Record<string, unknown>).serviceWorker;
  Object.defineProperty(window, "top", {
    configurable: true,
    value: window,
  });
  delete (globalThis as unknown as Record<string, unknown>).caches;
});

describe("registerOfflineServiceWorker", () => {
  it("registers when top-level + SW supported", async () => {
    const fakeRegistration = {
      scope: "/",
    } as unknown as ServiceWorkerRegistration;
    const register = vi.fn().mockResolvedValue(fakeRegistration);
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { register } as unknown as ServiceWorkerContainer,
    });

    const result = await registerOfflineServiceWorker();

    expect(result.status).toBe("registered");
    expect(result.registration).toBe(fakeRegistration);
    expect(register).toHaveBeenCalledWith("/sw.js", { scope: "/" });
  });

  it("skips when loaded inside an iframe", async () => {
    const register = vi.fn();
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { register } as unknown as ServiceWorkerContainer,
    });
    Object.defineProperty(window, "top", {
      configurable: true,
      value: { fake: true } as unknown as Window,
    });

    const result = await registerOfflineServiceWorker();

    expect(result).toEqual({ status: "skipped", reason: "iframe-or-unsupported" });
    expect(register).not.toHaveBeenCalled();
  });

  it("skips when navigator.serviceWorker is undefined", async () => {
    delete (navigator as unknown as Record<string, unknown>).serviceWorker;

    const result = await registerOfflineServiceWorker();

    expect(result).toEqual({ status: "skipped", reason: "iframe-or-unsupported" });
  });

  it("in development, self-heals (unregisters + clears caches) and never registers", async () => {
    vi.stubEnv("NODE_ENV", "development");

    const unregister = vi.fn().mockResolvedValue(true);
    const register = vi.fn();
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        register,
        getRegistrations: vi
          .fn()
          .mockResolvedValue([{ unregister }] as unknown[]),
      } as unknown as ServiceWorkerContainer,
    });

    const cacheDelete = vi.fn().mockResolvedValue(true);
    Object.defineProperty(globalThis, "caches", {
      configurable: true,
      value: {
        keys: vi.fn().mockResolvedValue(["serwist-precache-v2", "serwist-runtime"]),
        delete: cacheDelete,
      } as unknown as CacheStorage,
    });

    const result = await registerOfflineServiceWorker();

    expect(result).toEqual({ status: "skipped", reason: "development" });
    // The stale prod SW left in public/ is torn down, not re-registered.
    expect(register).not.toHaveBeenCalled();
    expect(unregister).toHaveBeenCalledTimes(1);
    expect(cacheDelete).toHaveBeenCalledTimes(2);
    expect(cacheDelete).toHaveBeenCalledWith("serwist-precache-v2");
    expect(cacheDelete).toHaveBeenCalledWith("serwist-runtime");
  });
});
