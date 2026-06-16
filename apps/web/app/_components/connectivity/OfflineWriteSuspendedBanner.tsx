"use client";

// P3C-03 — persistent "Offline — Write Access Suspended" banner shown on the
// desktop Salesforce-iframe surface whenever connectivity is degraded
// (TR-OFFLINE-2 / SAD v1.2 §6.5b). Modeled on `SupervisorReadOnlyBanner`
// for visual parity; differs in ARIA (`role="status" aria-live="polite"`)
// because this banner appears/disappears reactively — screen readers need
// the transition announcement, not a static `note`.
//
// Renders nothing when state is "online", so on the tablet PWA surface
// (where `ConnectivityProvider` keeps state at "online" forever — see
// `context.tsx`) this component is a no-op even though it's mounted.

import { useConnectivity } from "../../_lib/connectivity/context";

export function OfflineWriteSuspendedBanner() {
  const state = useConnectivity();
  if (state === "online") return null;
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="offline-write-suspended-banner"
      className="rounded-md border border-muted bg-muted/40 px-3 py-2 text-sm text-muted-foreground"
    >
      Offline &mdash; Write Access Suspended
    </div>
  );
}
