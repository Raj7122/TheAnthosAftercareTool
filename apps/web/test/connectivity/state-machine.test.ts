// P3C-03 — connectivity reducer (TR-OFFLINE-2 asymmetry). The "online_event"
// no-op is the load-bearing rule: TR-OFFLINE-2 requires recovery to come from
// a successful heartbeat, not from the browser's `online` event alone (which
// can fire when the network interface is up but the BFF is unreachable). A
// regression in this table would silently lift the banner on flaky networks
// where `/healthz` never returns ok.

import { describe, expect, it } from "vitest";

import {
  reduceConnectivity,
  type ConnectivityEvent,
  type ConnectivityState,
} from "../../app/_lib/connectivity/state-machine";

const EVENTS: ConnectivityEvent["type"][] = [
  "offline_event",
  "online_event",
  "heartbeat_ok",
  "heartbeat_fail",
];

describe("reduceConnectivity — exhaustive transition table", () => {
  const cases: ReadonlyArray<{
    state: ConnectivityState;
    event: ConnectivityEvent["type"];
    expected: ConnectivityState;
  }> = [
    // "online" inputs
    { state: "online", event: "offline_event", expected: "degraded" },
    { state: "online", event: "online_event", expected: "online" },
    { state: "online", event: "heartbeat_ok", expected: "online" },
    { state: "online", event: "heartbeat_fail", expected: "degraded" },
    // "degraded" inputs — the TR-OFFLINE-2 asymmetry lives here
    { state: "degraded", event: "offline_event", expected: "degraded" },
    {
      // `online_event` is intentionally a NO-OP: the browser can claim "online"
      // while the BFF stays unreachable. Recovery requires a proven probe.
      state: "degraded",
      event: "online_event",
      expected: "degraded",
    },
    { state: "degraded", event: "heartbeat_ok", expected: "online" },
    { state: "degraded", event: "heartbeat_fail", expected: "degraded" },
  ];

  for (const { state, event, expected } of cases) {
    it(`${state} + ${event} → ${expected}`, () => {
      expect(reduceConnectivity(state, { type: event } as ConnectivityEvent)).toBe(
        expected,
      );
    });
  }

  it("covers every event in the union (exhaustive over EVENTS)", () => {
    const seen = new Set(cases.map((c) => c.event));
    for (const e of EVENTS) {
      expect(seen.has(e)).toBe(true);
    }
  });
});
