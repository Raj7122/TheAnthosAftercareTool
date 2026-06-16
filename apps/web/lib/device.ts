"use client";

// P3B-01 / PDA-10: device-variant detection for F-13 tablet UI routing.
// Returns 'tablet' only when ALL four signals agree (viewport <1024px in
// portrait + (pointer: coarse) + touch points present + a tablet-class
// UA). The four-signal AND-gate is the "resilient to UA spoofing"
// requirement (ticket AC #3): a spoofed UA on a fine-pointer non-touch
// desktop stays 'laptop'. On ambiguity (missing signals, SSR, Chrome
// DevTools without a tablet UA preset) we default to 'laptop' so the
// tablet variant is intentional, not accidental
// (P3B-01 ticket — Notes for the implementing agent).
//
// Tablet-class UA covers both iPadOS-Safari and Android tablets. Android
// Chrome includes "Mobile" in the UA on phones and omits it on tablets,
// so `/Android/ && !/Mobile/` selects tablets without catching phones.
// Kept inside the AND-gate, so a non-touch fine-pointer desktop spoofing
// an Android UA still resolves to 'laptop'.
//
// `?view=tablet` / `?view=laptop` force the variant regardless of signals
// (see `resolveViewOverride`) — an explicit escape hatch for demos and
// field QA on devices the heuristic can't classify.

import { useEffect, useState } from "react";

export type DeviceVariant = "tablet" | "laptop";

export interface DeviceDetectionInput {
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly orientation: "portrait" | "landscape";
  readonly pointer: "coarse" | "fine" | "none";
  readonly maxTouchPoints: number;
  readonly userAgent: string;
}

const IPAD_UA_PATTERN = /iPad/;
const MACINTOSH_UA_PATTERN = /Macintosh/;
// iPad's Macintosh-shaped UA never reports a non-Safari engine token, so
// any Chromium/Gecko/Edge tail means we're on a real Mac.
const NON_SAFARI_ENGINE_PATTERN = /Chrome|CriOS|Firefox|FxiOS|Edg/;
const ANDROID_UA_PATTERN = /Android/;
// Android phones carry "Mobile" in the UA; tablets omit it. This is the
// standard phone-vs-tablet split for Android Chrome/WebView.
const ANDROID_MOBILE_UA_PATTERN = /Mobile/;

export function detectDeviceVariant(
  input: DeviceDetectionInput,
): DeviceVariant {
  if (input.orientation !== "portrait") return "laptop";
  if (input.viewportWidth >= 1024) return "laptop";
  if (input.pointer !== "coarse") return "laptop";
  if (input.maxTouchPoints <= 0) return "laptop";

  const ua = input.userAgent;
  const isIPadUa = IPAD_UA_PATTERN.test(ua);
  // iPadOS 13+ identifies as Macintosh Safari; the only runtime
  // distinguisher is maxTouchPoints > 1 (a real Mac with a trackpad
  // reports 0 or 1 — never more).
  const isIPadOSAsMac =
    MACINTOSH_UA_PATTERN.test(ua) &&
    !NON_SAFARI_ENGINE_PATTERN.test(ua) &&
    input.maxTouchPoints > 1;
  // Android tablet: Android UA without the phone-only "Mobile" token. The
  // touch + coarse-pointer gates above already excluded a desktop spoofing
  // an Android UA.
  const isAndroidTablet =
    ANDROID_UA_PATTERN.test(ua) && !ANDROID_MOBILE_UA_PATTERN.test(ua);
  if (!isIPadUa && !isIPadOSAsMac && !isAndroidTablet) return "laptop";

  return "tablet";
}

// `?view=tablet` / `?view=laptop` force the variant, bypassing signal
// detection. Returns null when the param is absent or unrecognized, so
// the caller falls through to `detectDeviceVariant`. Pure (takes a raw
// query string) so it is unit-testable without a browser.
export const VIEW_OVERRIDE_PARAM = "view";
// Session-sticky storage slot for the `?view=` override (P3B-01b).
export const VIEW_OVERRIDE_STORAGE_KEY = "anthos.view-override";

export function resolveViewOverride(search: string): DeviceVariant | null {
  const value = new URLSearchParams(search).get(VIEW_OVERRIDE_PARAM);
  if (value === "tablet") return "tablet";
  if (value === "laptop") return "laptop";
  return null;
}

// P3B-01b — session-sticky `?view=` override. An explicit `?view=tablet|laptop`
// in the URL wins AND is persisted for the browser session; on later resolves
// where the param is absent — an in-app `<Link>` that omits it, or the
// `/caseload` 401 → login redirect that drops the query string entirely — the
// persisted value still applies, so a forced variant doesn't silently revert to
// signal detection mid-session. `?view=auto` clears the stickiness and falls
// back to detection. Pure (storage injected) so it is unit-testable without a
// browser; storage access is guarded because private-mode / sandboxed contexts
// can throw on access.
export function resolveStickyViewOverride(
  search: string,
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null,
): DeviceVariant | null {
  const param = new URLSearchParams(search).get(VIEW_OVERRIDE_PARAM);
  if (param === "auto") {
    try {
      storage?.removeItem(VIEW_OVERRIDE_STORAGE_KEY);
    } catch {
      // Storage unavailable — nothing to clear.
    }
    return null;
  }
  if (param === "tablet" || param === "laptop") {
    try {
      storage?.setItem(VIEW_OVERRIDE_STORAGE_KEY, param);
    } catch {
      // Storage unavailable — the override still applies for this resolve.
    }
    return param;
  }
  try {
    const stored = storage?.getItem(VIEW_OVERRIDE_STORAGE_KEY) ?? null;
    if (stored === "tablet" || stored === "laptop") return stored;
  } catch {
    // Storage unavailable — fall through to signal detection.
  }
  return null;
}

// `window.sessionStorage`, guarded — null under SSR or when access throws
// (Safari private mode, sandboxed iframes).
function safeSessionStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

// Synchronous, one-shot variant resolution from the live `window`. Reads the
// same four signals (plus the `?view=` override) as the hook's subscription,
// but without the React state/listener machinery. Returns 'laptop' under SSR
// (no `window`). Use this when you need the *real* variant immediately on
// mount and can't wait for `useDeviceVariant`'s effect to flip its
// 'laptop'-default state — e.g. a redirect decision that must not fire on the
// SSR default and mis-route a tablet (P3B-02 LandingSwitch laptop redirect).
export function resolveCurrentDeviceVariant(): DeviceVariant {
  if (typeof window === "undefined") return "laptop";

  // Explicit override wins over signal detection (demos / field QA), and is
  // sticky for the session so it survives navigation + the /caseload login
  // redirect that drops the query string (P3B-01b).
  const override = resolveStickyViewOverride(
    window.location.search,
    safeSessionStorage(),
  );
  if (override) return override;

  const coarse = window.matchMedia("(pointer: coarse)").matches;
  const fine = window.matchMedia("(pointer: fine)").matches;
  const pointer: "coarse" | "fine" | "none" = coarse
    ? "coarse"
    : fine
      ? "fine"
      : "none";
  return detectDeviceVariant({
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    orientation: window.matchMedia("(orientation: portrait)").matches
      ? "portrait"
      : "landscape",
    pointer,
    maxTouchPoints: window.navigator.maxTouchPoints ?? 0,
    userAgent: window.navigator.userAgent,
  });
}

export function useDeviceVariant(): DeviceVariant {
  // SSR-safe initial: server has no window/navigator, and the tablet
  // variant should be intentional. 'laptop' is also what every test
  // that defaults `input(...)` collapses to.
  const [variant, setVariant] = useState<DeviceVariant>("laptop");

  useEffect(() => {
    if (typeof window === "undefined") return;

    // Subscribing to (orientation+max-width) and (pointer: coarse) is
    // enough to catch the only realistic state transitions:
    // rotation (portrait <-> landscape) and width change crossing
    // 1024px. UA / maxTouchPoints don't change during a session.
    const portraitNarrowQuery = window.matchMedia(
      "(max-width: 1023px) and (orientation: portrait)",
    );
    const coarsePointerQuery = window.matchMedia("(pointer: coarse)");

    setVariant(resolveCurrentDeviceVariant());

    const onChange = () => setVariant(resolveCurrentDeviceVariant());
    portraitNarrowQuery.addEventListener("change", onChange);
    coarsePointerQuery.addEventListener("change", onChange);
    return () => {
      portraitNarrowQuery.removeEventListener("change", onChange);
      coarsePointerQuery.removeEventListener("change", onChange);
    };
  }, []);

  return variant;
}
