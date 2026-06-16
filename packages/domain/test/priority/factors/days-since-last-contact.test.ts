import { describe, expect, it } from "vitest";

import { daysSinceLastContactFactor } from "../../../src/priority/factors/days-since-last-contact.js";
import { makeConfig, makeParticipant } from "../_fixtures.js";

const config = makeConfig(); // daysSinceContactScoringCapDays: 90

describe("BR-19(a) — days_since_last_contact factor", () => {
  // TR-PRIORITY-14 + BR-15 + EC-08: null (never-contacted) MUST still surface
  // and typically classify Tier 1 — but it maps to the configured scoring cap
  // (a real operational boundary) rather than a runaway sentinel, so other
  // factors still register on a stacked active case.
  it("maps null to the scoring cap with a BR-15 label", () => {
    const result = daysSinceLastContactFactor.compute(
      makeParticipant({ days_since_last_contact: null }),
      config,
    );
    expect(result.valueNumeric).toBe(90); // cap, not 9999
    expect(result.valueLabel).toContain("never");
    expect(result.valueLabel).toContain("capped at 90d");
    expect(result.valueLabel).toContain("BR-15");
  });

  it("maps undefined to the same cap value as null", () => {
    const nullResult = daysSinceLastContactFactor.compute(
      makeParticipant({ days_since_last_contact: null }),
      config,
    );
    const undefinedResult = daysSinceLastContactFactor.compute(
      makeParticipant(),
      config,
    );
    expect(undefinedResult).toEqual(nullResult);
  });

  // The whole point of the cap: never-contacted no longer drowns everything.
  // It equals the cap, and a finite gap below the cap stays proportional.
  it("never-contacted equals the cap and does not dwarf a 67-day gap by 10x", () => {
    const gap = daysSinceLastContactFactor.compute(
      makeParticipant({ days_since_last_contact: 67 }),
      config,
    );
    const never = daysSinceLastContactFactor.compute(
      makeParticipant({ days_since_last_contact: null }),
      config,
    );
    expect(gap.valueNumeric).toBe(67);
    expect(never.valueNumeric).toBe(90);
    expect(never.valueNumeric).toBeLessThan(gap.valueNumeric * 10);
  });

  it("clamps a gap above the cap down to the cap with a capped label", () => {
    const result = daysSinceLastContactFactor.compute(
      makeParticipant({ days_since_last_contact: 120 }),
      config,
    );
    expect(result.valueNumeric).toBe(90);
    expect(result.valueLabel).toBe("120 days (capped at 90d)");
  });

  it("passes the cap boundary through without a capped label", () => {
    const result = daysSinceLastContactFactor.compute(
      makeParticipant({ days_since_last_contact: 90 }),
      config,
    );
    expect(result).toEqual({ valueLabel: "90 days", valueNumeric: 90 });
  });

  it("passes a positive integer below the cap through", () => {
    const result = daysSinceLastContactFactor.compute(
      makeParticipant({ days_since_last_contact: 16 }),
      config,
    );
    expect(result).toEqual({ valueLabel: "16 days", valueNumeric: 16 });
  });

  it("honors a custom cap from configuration", () => {
    const tightCap = makeConfig({ daysSinceContactScoringCapDays: 60 });
    const result = daysSinceLastContactFactor.compute(
      makeParticipant({ days_since_last_contact: 120 }),
      tightCap,
    );
    expect(result.valueNumeric).toBe(60);
    expect(result.valueLabel).toBe("120 days (capped at 60d)");
  });

  it("clamps a negative value to 0", () => {
    const result = daysSinceLastContactFactor.compute(
      makeParticipant({ days_since_last_contact: -3 }),
      config,
    );
    expect(result).toEqual({ valueLabel: "0 days", valueNumeric: 0 });
  });

  it("throws on a non-numeric value", () => {
    expect(() =>
      daysSinceLastContactFactor.compute(
        makeParticipant({ days_since_last_contact: "16" }),
        config,
      ),
    ).toThrow(/number\|null/);
  });
});
