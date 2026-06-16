// P3C-01 — Service Worker registration entry point for the tablet PWA
// surface (ADR-05 §6.5a; SAD v1.2 §6.5a).
//
// Guarded by `isTopLevelOriginSurface()` so we never attempt registration
// from inside the Salesforce Lightning Web Tab iframe — PF-05 evidence
// showed registration succeeds but
// `navigator.serviceWorker.controller` stays null there, so any work this
// code does in that context is misleading at best.
//
// `@serwist/next` is configured with `register: false` in `next.config.ts`
// so it does NOT auto-register. This function is the only registration
// path; the SW file at `/sw.js` is what `@serwist/next` emitted from
// `sw.ts` at build.

import { isTopLevelOriginSurface } from "./pwa-surface";

const SW_URL = "/sw.js" as const;
const SW_SCOPE = "/" as const;

export interface RegisterResult {
  readonly status: "registered" | "skipped";
  readonly reason?: "iframe-or-unsupported" | "development";
  readonly registration?: ServiceWorkerRegistration;
}

export async function registerOfflineServiceWorker(): Promise<RegisterResult> {
  // Mirror the `next.config.ts` build gate (`disable: NODE_ENV === "development"`):
  // Serwist emits no SW in dev, but a stale prod-built `/sw.js` left in
  // `public/` would otherwise be (re-)registered by `next dev` and precache
  // dead, hashed chunks — the "Cannot read properties of undefined (reading
  // 'call')" trap. Self-heal: tear down any leftover worker + its caches so
  // dev always loads fresh from the network. `process.env.NODE_ENV` is inlined
  // by webpack, so this whole branch is dead-code-eliminated from the prod
  // bundle — the production registration path below is unchanged.
  if (process.env.NODE_ENV === "development") {
    if (typeof navigator !== "undefined" && navigator.serviceWorker) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
    if (typeof caches !== "undefined") {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
    return { status: "skipped", reason: "development" };
  }
  if (!isTopLevelOriginSurface()) {
    return { status: "skipped", reason: "iframe-or-unsupported" };
  }
  const registration = await navigator.serviceWorker.register(SW_URL, {
    scope: SW_SCOPE,
  });
  return { status: "registered", registration };
}
