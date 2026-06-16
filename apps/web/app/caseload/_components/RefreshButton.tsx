"use client";

import { RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";

import { useConnectivity } from "../../_lib/connectivity/context";
import type { RefreshState } from "../_lib/useRefreshCaseload";

interface Props {
  readonly state: RefreshState;
  readonly retryAfterSeconds: number;
  readonly onClick: () => void;
}

// F-16 "Hard refresh" control on the caseload page. Renders one label per
// state and disables itself during pending + rateLimited so a second click
// can't fire mid-window. The `h-11` floor is the F-13 tablet finger-target
// minimum — matches the "Why?" affordance pattern in CaseloadRow.
//
// aria-live="polite" on the label so the screen reader announces "Refreshing…"
// and "Retry in 23s" transitions without barging in on whatever the
// specialist is currently reading.
export function RefreshButton({ state, retryAfterSeconds, onClick }: Props) {
  // P3C-03 — desktop iframe surface: visibly disable Refresh when offline
  // (TR-OFFLINE-2 / BR-67). The /api/v1/caseload/refresh endpoint is a POST
  // that mutates the server-side sync state, so it counts as a write under
  // BR-67. No-op on tablet PWA (state pinned to "online").
  const connectivity = useConnectivity();
  const writesBlocked = connectivity === "degraded";
  const disabled = state === "pending" || state === "rateLimited" || writesBlocked;
  return (
    <Button
      type="button"
      variant="accent"
      onClick={onClick}
      disabled={disabled}
      data-testid="caseload-refresh"
      data-state={state}
      title={writesBlocked ? "Offline — Write Access Suspended" : undefined}
      className="h-11 gap-2 px-4"
      aria-label={ariaLabelFor(state, retryAfterSeconds)}
    >
      <RefreshCw
        aria-hidden="true"
        className={`h-3.5 w-3.5 ${state === "pending" ? "animate-spin" : ""}`}
      />
      <span aria-live="polite">{labelFor(state, retryAfterSeconds)}</span>
    </Button>
  );
}

function labelFor(state: RefreshState, retryAfterSeconds: number): string {
  if (state === "pending") return "Refreshing…";
  if (state === "rateLimited") return `Retry in ${retryAfterSeconds}s`;
  return "Refresh";
}

function ariaLabelFor(state: RefreshState, retryAfterSeconds: number): string {
  if (state === "pending") return "Refreshing caseload";
  if (state === "rateLimited") {
    return `Rate limited; retry available in ${retryAfterSeconds} seconds`;
  }
  return "Refresh caseload";
}
