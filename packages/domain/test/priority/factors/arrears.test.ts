import { describe, expect, it } from "vitest";

import { arrearsFactor } from "../../../src/priority/factors/arrears.js";
import { makeConfig, makeParticipant } from "../_fixtures.js";

const config = makeConfig();

describe("BR-19(g) — arrears factor", () => {
  // Pattern F: this factor computes a transparent count now but lands at
  // config weight 0 (calibration-config.ts), so it contributes 0 priority
  // points until the FS §F-03 BR-19(g) erratum + P0-14. These tests exercise
  // the compute() rule directly — weight application is the engine's concern.

  it("returns 'no arrears' / 0 when the field is missing", () => {
    const result = arrearsFactor.compute(makeParticipant(), config);
    expect(result).toEqual({ valueLabel: "no arrears", valueNumeric: 0 });
  });

  it("returns 'no arrears' / 0 when the field is null", () => {
    const result = arrearsFactor.compute(
      makeParticipant({ arrears: null }),
      config,
    );
    expect(result).toEqual({ valueLabel: "no arrears", valueNumeric: 0 });
  });

  it("returns 'no arrears' / 0 for an empty array", () => {
    const result = arrearsFactor.compute(
      makeParticipant({ arrears: [] }),
      config,
    );
    expect(result).toEqual({ valueLabel: "no arrears", valueNumeric: 0 });
  });

  it("returns 'no arrears' / 0 when every arrear is in a closed status", () => {
    const result = arrearsFactor.compute(
      makeParticipant({
        arrears: [
          { status: "Resolved With Anthos Payment" },
          { status: "Resolved Without Anthos Payment" },
        ],
      }),
      config,
    );
    expect(result).toEqual({ valueLabel: "no arrears", valueNumeric: 0 });
  });

  it("counts only open-status arrears when statuses are mixed", () => {
    const result = arrearsFactor.compute(
      makeParticipant({
        arrears: [
          { status: "Identified" },
          { status: "Resolved With Anthos Payment" },
          { status: "Under Review" },
          { status: "Resolved Without Anthos Payment" },
        ],
      }),
      config,
    );
    // Identified + Under Review are open; the two Resolved values are closed.
    expect(result).toEqual({ valueLabel: "2 open arrears", valueNumeric: 2 });
  });

  it("treats 'Approved' as an open status (P0-08b default)", () => {
    const result = arrearsFactor.compute(
      makeParticipant({ arrears: [{ status: "Approved" }] }),
      config,
    );
    expect(result).toEqual({ valueLabel: "1 open arrear", valueNumeric: 1 });
  });

  it("counts every open arrear across a multi-record collection", () => {
    const result = arrearsFactor.compute(
      makeParticipant({
        arrears: [
          { status: "Identified" },
          { status: "Under Review" },
          { status: "Approved" },
          { status: "Identified" },
        ],
      }),
      config,
    );
    expect(result).toEqual({ valueLabel: "4 open arrears", valueNumeric: 4 });
  });

  it("ignores an entry whose status is absent or unrecognized", () => {
    const result = arrearsFactor.compute(
      makeParticipant({
        arrears: [{ status: "Identified" }, {}, { status: "Withdrawn" }],
      }),
      config,
    );
    expect(result).toEqual({ valueLabel: "1 open arrear", valueNumeric: 1 });
  });

  it("throws when arrears is not an array", () => {
    expect(() =>
      arrearsFactor.compute(
        makeParticipant({ arrears: "Identified" }),
        config,
      ),
    ).toThrow(/must be array/);
  });
});
