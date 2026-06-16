// P3C-01 — "are we on the tablet PWA surface where the SW can control?"
// guard (ADR-05 §6.5a vs §6.5b).
//
// The PF-05 spike (2026-05-17) proved that a Service Worker can register and
// activate inside the Salesforce Lightning Web Tab iframe but never acquires
// control (`navigator.serviceWorker.controller === null` in both Chromium
// 148 and WebKit 26.4). The discriminator is the iframe context, not the
// device, so the guard is "am I top-level?", not "am I a tablet?". A
// desktop user who navigates directly to the PWA origin gets the SW too —
// which is the correct §6.5a branch per SAD v1.2.
//
// `window.self === window.top` returning false → we're inside an iframe;
// the throw-handling catches the cross-origin SecurityError some browsers
// raise when reading `window.top` from a same-origin frame nested inside a
// cross-origin parent.

export function isTopLevelOriginSurface(): boolean {
  if (typeof window === "undefined") return false;
  if (!("serviceWorker" in navigator)) return false;
  try {
    return window.self === window.top;
  } catch {
    return false;
  }
}
