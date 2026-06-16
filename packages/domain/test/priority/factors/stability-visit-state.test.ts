import { describe, expect, it } from "vitest";

import { stabilityVisitStateFactor } from "../../../src/priority/factors/stability-visit-state.js";
import { makeConfig, makeParticipant } from "../_fixtures.js";

const config = makeConfig();

describe("BR-19(b) — stability_visit_state factor", () => {
  it.each([
    { state: "on_track", numeric: 0, label: "On track" },
    { state: "upcoming", numeric: 1, label: "Upcoming" },
    { state: "catchup", numeric: 2, label: "Catch-up" },
    { state: "missed", numeric: 3, label: "Missed" },
  ])("maps $state to $numeric with label $label", ({ state, numeric, label }) => {
    const result = stabilityVisitStateFactor.compute(
      makeParticipant({ stability_visit_state: state }),
      config,
    );
    expect(result).toEqual({ valueLabel: label, valueNumeric: numeric });
  });

  it("throws on an unknown enum value (fail-loud)", () => {
    expect(() =>
      stabilityVisitStateFactor.compute(
        makeParticipant({ stability_visit_state: "halfway" }),
        config,
      ),
    ).toThrow(/unknown value 'halfway'/);
  });

  it("throws when value is not a string", () => {
    expect(() =>
      stabilityVisitStateFactor.compute(
        makeParticipant({ stability_visit_state: 2 }),
        config,
      ),
    ).toThrow(/must be string/);
  });
});
