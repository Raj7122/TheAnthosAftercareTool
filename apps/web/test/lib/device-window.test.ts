// @vitest-environment happy-dom

// `resolveCurrentDeviceVariant` — the synchronous, live-`window` resolver the
// LandingSwitch laptop redirect reads on mount (it must see the REAL variant,
// not `useDeviceVariant`'s 'laptop' default). The signal-combination matrix is
// exhaustively covered by `device.test.ts` against the pure
// `detectDeviceVariant`; this asserts the wiring from `window` + the `?view=`
// override into that pure core.

import { beforeEach, describe, expect, it } from "vitest";

import { resolveCurrentDeviceVariant } from "../../lib/device";

beforeEach(() => {
  // The sticky `?view=` override persists to sessionStorage; isolate each case.
  window.sessionStorage.clear();
});

const IPAD_SAFARI_UA =
  "Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1";
const MAC_CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function setWindow(opts: {
  width: number;
  height: number;
  portrait: boolean;
  pointer: "coarse" | "fine" | "none";
  maxTouchPoints: number;
  userAgent: string;
  search?: string;
}): void {
  window.matchMedia = ((query: string) => {
    const matches =
      query === "(pointer: coarse)"
        ? opts.pointer === "coarse"
        : query === "(pointer: fine)"
          ? opts.pointer === "fine"
          : query === "(orientation: portrait)"
            ? opts.portrait
            : false;
    return {
      matches,
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent() {
        return false;
      },
    } as unknown as MediaQueryList;
  }) as typeof window.matchMedia;

  Object.defineProperty(window, "innerWidth", {
    value: opts.width,
    configurable: true,
  });
  Object.defineProperty(window, "innerHeight", {
    value: opts.height,
    configurable: true,
  });
  Object.defineProperty(window.navigator, "maxTouchPoints", {
    value: opts.maxTouchPoints,
    configurable: true,
  });
  Object.defineProperty(window.navigator, "userAgent", {
    value: opts.userAgent,
    configurable: true,
  });
  window.history.replaceState({}, "", `/${opts.search ?? ""}`);
}

describe("resolveCurrentDeviceVariant", () => {
  it("resolves 'tablet' from live iPad portrait signals", () => {
    setWindow({
      width: 768,
      height: 1024,
      portrait: true,
      pointer: "coarse",
      maxTouchPoints: 5,
      userAgent: IPAD_SAFARI_UA,
    });
    expect(resolveCurrentDeviceVariant()).toBe("tablet");
  });

  it("resolves 'laptop' from a desktop Chrome window", () => {
    setWindow({
      width: 1440,
      height: 900,
      portrait: false,
      pointer: "fine",
      maxTouchPoints: 0,
      userAgent: MAC_CHROME_UA,
    });
    expect(resolveCurrentDeviceVariant()).toBe("laptop");
  });

  it("honors ?view=laptop on a tablet-shaped window", () => {
    setWindow({
      width: 768,
      height: 1024,
      portrait: true,
      pointer: "coarse",
      maxTouchPoints: 5,
      userAgent: IPAD_SAFARI_UA,
      search: "?view=laptop",
    });
    expect(resolveCurrentDeviceVariant()).toBe("laptop");
  });

  it("honors ?view=tablet on a laptop-shaped window", () => {
    setWindow({
      width: 1440,
      height: 900,
      portrait: false,
      pointer: "fine",
      maxTouchPoints: 0,
      userAgent: MAC_CHROME_UA,
      search: "?view=tablet",
    });
    expect(resolveCurrentDeviceVariant()).toBe("tablet");
  });

  it("keeps ?view=tablet sticky across a later param-less resolve (P3B-01b)", () => {
    // First load forces tablet via the query param…
    setWindow({
      width: 1024,
      height: 768,
      portrait: false,
      pointer: "fine",
      maxTouchPoints: 0,
      userAgent: MAC_CHROME_UA,
      search: "?view=tablet",
    });
    expect(resolveCurrentDeviceVariant()).toBe("tablet");
    // …then a navigation drops the param (e.g. the /caseload login redirect);
    // the laptop-shaped signals would resolve 'laptop' without the sticky store.
    setWindow({
      width: 1024,
      height: 768,
      portrait: false,
      pointer: "fine",
      maxTouchPoints: 0,
      userAgent: MAC_CHROME_UA,
    });
    expect(resolveCurrentDeviceVariant()).toBe("tablet");
  });

  it("clears the sticky override on ?view=auto (P3B-01b)", () => {
    setWindow({
      width: 1024,
      height: 768,
      portrait: false,
      pointer: "fine",
      maxTouchPoints: 0,
      userAgent: MAC_CHROME_UA,
      search: "?view=tablet",
    });
    expect(resolveCurrentDeviceVariant()).toBe("tablet");
    // ?view=auto forgets the override → falls back to signal detection.
    setWindow({
      width: 1440,
      height: 900,
      portrait: false,
      pointer: "fine",
      maxTouchPoints: 0,
      userAgent: MAC_CHROME_UA,
      search: "?view=auto",
    });
    expect(resolveCurrentDeviceVariant()).toBe("laptop");
  });
});
