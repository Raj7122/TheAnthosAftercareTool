"use client";

// P3C-03 — mount point for the desktop iframe surface's connectivity layer.
// Wraps `children` in `ConnectivityProvider` and renders the persistent
// banner just above. Mounted once at the root layout, sibling to the
// existing `PWABootstrap` (which handles the tablet PWA surface).
//
// The cross-surface isolation is enforced *inside* `ConnectivityProvider`:
// it inspects `isTopLevelOriginSurface()` in its `useEffect` and skips
// timers / event listeners / probes on the tablet surface, leaving state
// pinned at "online" so the banner renders `null`. Keeping the tree shape
// identical on both surfaces avoids hydration mismatches.

import { ConnectivityProvider } from "../../_lib/connectivity/context";

import { OfflineWriteSuspendedBanner } from "./OfflineWriteSuspendedBanner";
import { SyncOnReconnect } from "./SyncOnReconnect";

import type { ReactNode } from "react";

interface Props {
  readonly children: ReactNode;
}

export function IframeConnectivityBootstrap({ children }: Props) {
  return (
    <ConnectivityProvider>
      <OfflineWriteSuspendedBanner />
      <SyncOnReconnect />
      {children}
    </ConnectivityProvider>
  );
}
