import { describe, expect, it } from "vitest";

import {
  detectDeviceVariant,
  resolveStickyViewOverride,
  resolveViewOverride,
  VIEW_OVERRIDE_STORAGE_KEY,
  type DeviceDetectionInput,
} from "../../lib/device";

const IPAD_SAFARI_UA =
  "Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1";
const IPAD_AS_MAC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Safari/605.1.15";
const MAC_SAFARI_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
const MAC_CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
// Samsung Galaxy Tab A (SM-T510), Chrome — note the absence of "Mobile".
const ANDROID_TABLET_UA =
  "Mozilla/5.0 (Linux; Android 11; SM-T510) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
// Android phone (Pixel), Chrome — carries the "Mobile" token.
const ANDROID_PHONE_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";

function input(
  overrides: Partial<DeviceDetectionInput>,
): DeviceDetectionInput {
  return {
    viewportWidth: 1440,
    viewportHeight: 900,
    orientation: "landscape",
    pointer: "fine",
    maxTouchPoints: 0,
    userAgent: MAC_CHROME_UA,
    ...overrides,
  };
}

describe("detectDeviceVariant", () => {
  it("returns 'tablet' on iPad portrait <1024px with iPadOS Safari UA, coarse pointer, and touch points", () => {
    expect(
      detectDeviceVariant(
        input({
          viewportWidth: 768,
          viewportHeight: 1024,
          orientation: "portrait",
          pointer: "coarse",
          maxTouchPoints: 5,
          userAgent: IPAD_SAFARI_UA,
        }),
      ),
    ).toBe("tablet");
  });

  it("returns 'laptop' after rotating the iPad to landscape", () => {
    expect(
      detectDeviceVariant(
        input({
          viewportWidth: 1024,
          viewportHeight: 768,
          orientation: "landscape",
          pointer: "coarse",
          maxTouchPoints: 5,
          userAgent: IPAD_SAFARI_UA,
        }),
      ),
    ).toBe("laptop");
  });

  it("returns 'tablet' on iPadOS 13+ reporting a Macintosh UA when maxTouchPoints > 1", () => {
    expect(
      detectDeviceVariant(
        input({
          viewportWidth: 820,
          viewportHeight: 1180,
          orientation: "portrait",
          pointer: "coarse",
          maxTouchPoints: 5,
          userAgent: IPAD_AS_MAC_UA,
        }),
      ),
    ).toBe("tablet");
  });

  it("returns 'laptop' on macOS Safari at a typical laptop viewport", () => {
    expect(
      detectDeviceVariant(
        input({
          viewportWidth: 1440,
          viewportHeight: 900,
          orientation: "landscape",
          pointer: "fine",
          maxTouchPoints: 0,
          userAgent: MAC_SAFARI_UA,
        }),
      ),
    ).toBe("laptop");
  });

  it("returns 'laptop' on macOS Chrome at a typical laptop viewport", () => {
    expect(
      detectDeviceVariant(
        input({
          viewportWidth: 1440,
          viewportHeight: 900,
          orientation: "landscape",
          pointer: "fine",
          maxTouchPoints: 0,
          userAgent: MAC_CHROME_UA,
        }),
      ),
    ).toBe("laptop");
  });

  it("returns 'laptop' for Chrome at iPad-sized window without device-mode spoofing (Chrome UA, fine pointer, 0 touch)", () => {
    expect(
      detectDeviceVariant(
        input({
          viewportWidth: 768,
          viewportHeight: 1024,
          orientation: "portrait",
          pointer: "fine",
          maxTouchPoints: 0,
          userAgent: MAC_CHROME_UA,
        }),
      ),
    ).toBe("laptop");
  });

  it("returns 'laptop' when only the UA is spoofed to iPad (no coarse pointer, no touch)", () => {
    expect(
      detectDeviceVariant(
        input({
          viewportWidth: 900,
          viewportHeight: 1200,
          orientation: "portrait",
          pointer: "fine",
          maxTouchPoints: 0,
          userAgent: IPAD_SAFARI_UA,
        }),
      ),
    ).toBe("laptop");
  });

  it("returns 'laptop' for a Macintosh UA reporting only 1 touch point (real Mac with trackpad, not an iPad)", () => {
    expect(
      detectDeviceVariant(
        input({
          viewportWidth: 820,
          viewportHeight: 1180,
          orientation: "portrait",
          pointer: "coarse",
          maxTouchPoints: 1,
          userAgent: IPAD_AS_MAC_UA,
        }),
      ),
    ).toBe("laptop");
  });

  it("returns 'laptop' when a Chromium-engined macOS browser presents a Macintosh UA with simulated touch (engine guard)", () => {
    // Defensive: if Chrome DevTools or some other tooling spoofs touch
    // count to >1 on a Macintosh-UA, the non-Safari engine tail keeps
    // us from misclassifying as iPad.
    expect(
      detectDeviceVariant(
        input({
          viewportWidth: 820,
          viewportHeight: 1180,
          orientation: "portrait",
          pointer: "coarse",
          maxTouchPoints: 5,
          userAgent: MAC_CHROME_UA,
        }),
      ),
    ).toBe("laptop");
  });

  it("returns 'laptop' at exactly 1024px portrait (boundary: spec says <1024px)", () => {
    expect(
      detectDeviceVariant(
        input({
          viewportWidth: 1024,
          viewportHeight: 1366,
          orientation: "portrait",
          pointer: "coarse",
          maxTouchPoints: 5,
          userAgent: IPAD_SAFARI_UA,
        }),
      ),
    ).toBe("laptop");
  });

  it("returns 'tablet' on an Android tablet (Galaxy Tab A) portrait <1024px, coarse pointer, touch points", () => {
    expect(
      detectDeviceVariant(
        input({
          viewportWidth: 800,
          viewportHeight: 1280,
          orientation: "portrait",
          pointer: "coarse",
          maxTouchPoints: 5,
          userAgent: ANDROID_TABLET_UA,
        }),
      ),
    ).toBe("tablet");
  });

  it("returns 'laptop' on an Android phone (UA carries the 'Mobile' token)", () => {
    expect(
      detectDeviceVariant(
        input({
          viewportWidth: 412,
          viewportHeight: 915,
          orientation: "portrait",
          pointer: "coarse",
          maxTouchPoints: 5,
          userAgent: ANDROID_PHONE_UA,
        }),
      ),
    ).toBe("laptop");
  });

  it("returns 'laptop' when an Android UA is spoofed on a fine-pointer non-touch desktop", () => {
    expect(
      detectDeviceVariant(
        input({
          viewportWidth: 800,
          viewportHeight: 1280,
          orientation: "portrait",
          pointer: "fine",
          maxTouchPoints: 0,
          userAgent: ANDROID_TABLET_UA,
        }),
      ),
    ).toBe("laptop");
  });
});

describe("resolveViewOverride", () => {
  it("forces 'tablet' on ?view=tablet", () => {
    expect(resolveViewOverride("?view=tablet")).toBe("tablet");
  });

  it("forces 'laptop' on ?view=laptop", () => {
    expect(resolveViewOverride("?view=laptop")).toBe("laptop");
  });

  it("returns null when the param is absent", () => {
    expect(resolveViewOverride("?demo=sf")).toBeNull();
  });

  it("returns null for an unrecognized value", () => {
    expect(resolveViewOverride("?view=phone")).toBeNull();
  });
});

describe("resolveStickyViewOverride", () => {
  function fakeStorage(initial?: string): {
    store: Map<string, string>;
    getItem: (k: string) => string | null;
    setItem: (k: string, v: string) => void;
    removeItem: (k: string) => void;
  } {
    const store = new Map<string, string>();
    if (initial !== undefined) store.set(VIEW_OVERRIDE_STORAGE_KEY, initial);
    return {
      store,
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => {
        store.set(k, v);
      },
      removeItem: (k) => {
        store.delete(k);
      },
    };
  }

  it("persists an explicit ?view=tablet to storage and returns it", () => {
    const s = fakeStorage();
    expect(resolveStickyViewOverride("?view=tablet", s)).toBe("tablet");
    expect(s.store.get(VIEW_OVERRIDE_STORAGE_KEY)).toBe("tablet");
  });

  it("returns the persisted override when no param is present", () => {
    const s = fakeStorage("tablet");
    expect(resolveStickyViewOverride("", s)).toBe("tablet");
    expect(resolveStickyViewOverride("?demo=sf", s)).toBe("tablet");
  });

  it("?view=laptop overrides a previously-stored tablet preference", () => {
    const s = fakeStorage("tablet");
    expect(resolveStickyViewOverride("?view=laptop", s)).toBe("laptop");
    expect(s.store.get(VIEW_OVERRIDE_STORAGE_KEY)).toBe("laptop");
  });

  it("?view=auto clears the persisted override and returns null", () => {
    const s = fakeStorage("tablet");
    expect(resolveStickyViewOverride("?view=auto", s)).toBeNull();
    expect(s.store.has(VIEW_OVERRIDE_STORAGE_KEY)).toBe(false);
  });

  it("returns null (and does not throw) when storage is unavailable", () => {
    expect(resolveStickyViewOverride("", null)).toBeNull();
    // An explicit param still applies even if it can't be persisted.
    expect(resolveStickyViewOverride("?view=tablet", null)).toBe("tablet");
  });
});
