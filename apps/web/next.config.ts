import type { NextConfig } from "next";
import withSerwistInit from "@serwist/next";

import { buildFrameAncestorsCsp, loadCspConfig } from "./lib/csp";

// P3C-01 (ADR-05 §6.5a tablet PWA surface): @serwist/next bundles `sw.ts`
// into `public/sw.js` at build. `register: false` because
// `registerOfflineServiceWorker()` runs the iframe-guarded registration
// itself (PF-05: never register from inside the SF Lightning Web Tab
// iframe). `disable` in dev avoids the SW caching mid-iteration; we
// re-enable in `pnpm build` flows. `cacheOnNavigation: false` keeps the
// navigation-preload story simple while we're still on Next 15.5.
const withSerwist = withSerwistInit({
  swSrc: "sw.ts",
  swDest: "public/sw.js",
  register: false,
  disable: process.env.NODE_ENV === "development",
  cacheOnNavigation: false,
  reloadOnOnline: true,
});

const nextConfig: NextConfig = {
  transpilePackages: [
    "@anthos/api",
    "@anthos/domain",
    "@anthos/feature-flags",
    "@anthos/integrations",
  ],
  // CSP `frame-ancestors` on every response — the iframe parent-frame trust
  // boundary (TR-AUTH-5, API §8.6). `source: "/:path*"` covers every route so
  // no HTML response can ship un-headered; applying it to API JSON too is
  // harmless. `X-Frame-Options` is intentionally NEVER set (TR-AUTH-5: "MUST
  // NOT be used"). The allowlist is env-driven via `loadCspConfig()`.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "Content-Security-Policy",
            value: buildFrameAncestorsCsp(loadCspConfig()),
          },
        ],
      },
    ];
  },
  // Workspace TS sources import with NodeNext-style `.js` extensions
  // (matches tsconfig.base.json). Webpack needs to know that `./foo.js`
  // can resolve to `./foo.ts` when bundling transpiled workspace packages.
  webpack(config) {
    config.resolve = config.resolve ?? {};
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
};

export default withSerwist(nextConfig);
