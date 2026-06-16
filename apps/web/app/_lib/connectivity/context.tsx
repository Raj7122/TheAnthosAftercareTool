"use client";

// P3C-03 — connectivity React context for the desktop Salesforce-iframe
// surface (ADR-05 fallback branch per SAD v1.2 §6.5b).
//
// Responsibilities:
//   * Expose the current `ConnectivityState` ("online" | "degraded") to any
//     consumer via `useConnectivity()`.
//   * On the iframe surface only (`!isTopLevelOriginSurface()`), poll the
//     `/healthz` BFF heartbeat on a 5-second cadence and subscribe to
//     `window` `online`/`offline` events. State transitions follow the
//     asymmetric rule encoded in `state-machine.ts` — recovery requires a
//     successful probe, not just a browser `online` event.
//   * On the tablet PWA surface (top-level origin), do NOTHING: no timer,
//     no fetch, no event listeners. State stays "online" forever. This is
//     the cross-surface isolation chokepoint — the tablet uses
//     `navigator.serviceWorker.controller` + Outbox flush state (P3C-01),
//     orthogonal signal path.
//
// The first probe fires immediately on mount (not after 5 seconds) so the
// worst-case banner latency on a real outage is one fetch RTT.

import {
  createContext,
  useContext,
  useEffect,
  useReducer,
  type ReactNode,
} from "react";

import { isTopLevelOriginSurface } from "../offline/pwa-surface";

import { probeHealthz } from "./probe";
import {
  reduceConnectivity,
  type ConnectivityEvent,
  type ConnectivityState,
} from "./state-machine";

const HEARTBEAT_INTERVAL_MS = 5000;

const ConnectivityContext = createContext<ConnectivityState>("online");

interface ProviderProps {
  readonly children: ReactNode;
  // Test seam — production callers omit this. When provided, the provider
  // calls `probe` instead of the real `/healthz` fetch so unit tests can
  // drive transitions deterministically without spying on global fetch.
  readonly probe?: () => Promise<boolean>;
}

export function ConnectivityProvider({ children, probe }: ProviderProps) {
  const [state, dispatch] = useReducer(reduceConnectivity, "online");

  useEffect(() => {
    // Cross-surface isolation: on the tablet PWA surface (top-level origin)
    // this code path stays inert. The tablet's offline UX reads SW controller
    // + Outbox state, not `/healthz`.
    if (isTopLevelOriginSurface()) {
      return;
    }

    const controller = new AbortController();
    const runProbe = probe ?? (() => probeHealthz(controller.signal));

    const tick = async (): Promise<void> => {
      const ok = await runProbe();
      if (controller.signal.aborted) return;
      const event: ConnectivityEvent = ok
        ? { type: "heartbeat_ok" }
        : { type: "heartbeat_fail" };
      dispatch(event);
    };

    const onOffline = (): void => dispatch({ type: "offline_event" });
    const onOnline = (): void => dispatch({ type: "online_event" });

    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);

    // Initial probe runs immediately so we don't wait a full interval before
    // detecting a startup-time outage.
    void tick();
    const intervalId = setInterval(() => {
      void tick();
    }, HEARTBEAT_INTERVAL_MS);

    return () => {
      controller.abort();
      clearInterval(intervalId);
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("online", onOnline);
    };
  }, [probe]);

  return (
    <ConnectivityContext.Provider value={state}>
      {children}
    </ConnectivityContext.Provider>
  );
}

export function useConnectivity(): ConnectivityState {
  return useContext(ConnectivityContext);
}

export { HEARTBEAT_INTERVAL_MS };
