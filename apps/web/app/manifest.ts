// P3C-01 — Next 15 metadata route → PWA web app manifest.
//
// Minimum-viable shape per the P3C-01 plan D6: enough for an iPad specialist
// to "Add to Home Screen" and launch the tool as a standalone PWA at the
// first-party origin (so the SW + IndexedDB Outbox path applies per ADR-05
// §6.5a). Multi-size icons, screenshots, shortcuts, and brand polish are a
// Phase 3D follow-up — not load-bearing for offline tolerance.

import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Anthos Aftercare",
    short_name: "Anthos",
    // P3B-01b — the installed PWA is the tablet field affordance (laptop
    // specialists use the Salesforce-Console iframe, not Add-to-Home-Screen).
    // Launch it in the tablet surface via the `?view=` override (now
    // session-sticky, so every in-app navigation stays in tablet layout even on
    // devices the signal heuristic misclassifies, e.g. SM-T510). `?view=auto`
    // clears it for anyone who installs on a non-tablet.
    start_url: "/?view=tablet",
    scope: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#0f172a",
    icons: [
      {
        src: "/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any",
      },
    ],
  };
}
