import { describe, expect, it } from "vitest";

import { unitEngagementFactor } from "../../../src/priority/factors/unit-engagement.js";
import { makeConfig, makeParticipant } from "../_fixtures.js";

const config = makeConfig();

describe("BR-19(f) — unit_engagement factor", () => {
  it.each([
    { state: "stable", numeric: 0, label: "Stable" },
    { state: "strained", numeric: 1, label: "Strained" },
    { state: "crisis", numeric: 2, label: "Crisis" },
  ])("maps $state to $numeric ($label)", ({ state, numeric, label }) => {
    const result = unitEngagementFactor.compute(
      makeParticipant({ unit_engagement: state }),
      config,
    );
    expect(result).toEqual({ valueLabel: label, valueNumeric: numeric });
  });

  it("throws on unknown value", () => {
    expect(() =>
      unitEngagementFactor.compute(
        makeParticipant({ unit_engagement: "unstable" }),
        config,
      ),
    ).toThrow(/unknown value 'unstable'/);
  });

  it("throws on non-string", () => {
    expect(() =>
      unitEngagementFactor.compute(
        makeParticipant({ unit_engagement: 1 }),
        config,
      ),
    ).toThrow(/must be string/);
  });
});
