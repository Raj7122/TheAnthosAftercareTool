import { describe, expect, it } from "vitest";

import { aftercareExtendedFactor } from "../../../src/priority/factors/aftercare-extended.js";
import { makeConfig, makeParticipant } from "../_fixtures.js";

const config = makeConfig();

describe("BR-19(h) — aftercare_extended factor", () => {
  it("maps true to 1 ('Extended')", () => {
    const result = aftercareExtendedFactor.compute(
      makeParticipant({ aftercare_extended: true }),
      config,
    );
    expect(result).toEqual({ valueLabel: "Extended", valueNumeric: 1 });
  });

  it("maps false to 0 ('Not extended')", () => {
    const result = aftercareExtendedFactor.compute(
      makeParticipant({ aftercare_extended: false }),
      config,
    );
    expect(result).toEqual({ valueLabel: "Not extended", valueNumeric: 0 });
  });

  it("maps missing to 0", () => {
    const result = aftercareExtendedFactor.compute(makeParticipant(), config);
    expect(result.valueNumeric).toBe(0);
  });

  it("throws on non-boolean", () => {
    expect(() =>
      aftercareExtendedFactor.compute(
        makeParticipant({ aftercare_extended: "yes" }),
        config,
      ),
    ).toThrow(/must be boolean/);
  });
});
