// P3C-03 — connectivity state machine for the desktop Salesforce-iframe
// surface (ADR-05 fallback branch per SAD v1.2 §6.5b). Pure reducer with no
// I/O so it can be exhaustively unit-tested without DOM, fetch, or timers.
//
// The asymmetry encoded here is TR-OFFLINE-2's load-bearing rule
// (TRD v1.9:511): "re-enabled on first successful heartbeat after reconnect".
//
//   * Any of `offline_event` / `heartbeat_fail`  → "degraded"   (fast detect)
//   * Only `heartbeat_ok`                        → "online"     (proven recovery)
//   * `online_event` is a NO-OP — the browser's "online" event can fire when
//     the network interface is up but the BFF is unreachable; the spec wants
//     us to wait for an actual successful probe before lifting the banner.

export type ConnectivityState = "online" | "degraded";

export type ConnectivityEvent =
  | { readonly type: "offline_event" }
  | { readonly type: "online_event" }
  | { readonly type: "heartbeat_ok" }
  | { readonly type: "heartbeat_fail" };

export function reduceConnectivity(
  state: ConnectivityState,
  event: ConnectivityEvent,
): ConnectivityState {
  switch (event.type) {
    case "offline_event":
    case "heartbeat_fail":
      return "degraded";
    case "heartbeat_ok":
      return "online";
    case "online_event":
      return state;
  }
}
