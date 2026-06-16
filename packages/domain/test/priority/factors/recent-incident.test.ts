import { describe, expect, it } from "vitest";

import { recentIncidentFactor } from "../../../src/priority/factors/recent-incident.js";
import { makeConfig, makeParticipant } from "../_fixtures.js";

const config = makeConfig();

describe("BR-19(d) — recent_incident factor", () => {
  it("maps true to 1 with descriptive label", () => {
    const result = recentIncidentFactor.compute(
      makeParticipant({ recent_incident: true }),
      config,
    );
    expect(result).toEqual({
      valueLabel: "yes (30-day window)",
      valueNumeric: 1,
    });
  });

  it("maps false to 0", () => {
    const result = recentIncidentFactor.compute(
      makeParticipant({ recent_incident: false }),
      config,
    );
    expect(result).toEqual({ valueLabel: "no", valueNumeric: 0 });
  });

  it("maps missing to 0", () => {
    const result = recentIncidentFactor.compute(makeParticipant(), config);
    expect(result).toEqual({ valueLabel: "no", valueNumeric: 0 });
  });

  it("throws on non-boolean", () => {
    expect(() =>
      recentIncidentFactor.compute(
        makeParticipant({ recent_incident: 1 }),
        config,
      ),
    ).toThrow(/must be boolean/);
  });
});
