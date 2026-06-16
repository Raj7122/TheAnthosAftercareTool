// @vitest-environment happy-dom

// P3C-01 — `isTopLevelOriginSurface()` is the iframe-vs-top-level
// discriminator behind every other guard in this surface (register-sw,
// PWABootstrap). The PF-05 spike outcome makes a regression here a silent
// way to ship registration in the desktop iframe surface.

import { afterEach, describe, expect, it, vi } from "vitest";

import { isTopLevelOriginSurface } from "../../app/_lib/offline/pwa-surface";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("isTopLevelOriginSurface", () => {
  it("returns true when top-level + SW supported (happy path)", () => {
    // happy-dom provides `window`, `navigator`, but no `serviceWorker`. Stub
    // the prop in place so the SW branch sees it without redefining the
    // whole `navigator` object.
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {} as ServiceWorkerContainer,
    });
    expect(isTopLevelOriginSurface()).toBe(true);
  });

  it("returns false when loaded inside an iframe (window.self !== window.top)", () => {
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {} as ServiceWorkerContainer,
    });
    const fakeTop = { fake: true } as unknown as Window;
    Object.defineProperty(window, "top", {
      configurable: true,
      value: fakeTop,
    });
    expect(isTopLevelOriginSurface()).toBe(false);
  });

  it("returns false when serviceWorker is unsupported", () => {
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: undefined,
    });
    // Removing the property entirely also satisfies the `in` check; the
    // explicit `undefined` is closer to what older browsers expose.
    delete (navigator as unknown as Record<string, unknown>).serviceWorker;
    expect(isTopLevelOriginSurface()).toBe(false);
  });

  it("returns false when accessing window.top throws (cross-origin parent)", () => {
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {} as ServiceWorkerContainer,
    });
    Object.defineProperty(window, "top", {
      configurable: true,
      get() {
        throw new DOMException("blocked by CORS", "SecurityError");
      },
    });
    expect(isTopLevelOriginSurface()).toBe(false);
  });
});
