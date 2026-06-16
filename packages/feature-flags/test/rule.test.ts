import { describe, expect, it } from "vitest";

import { evaluateRule, parseFlagRule } from "../src/rule.js";
import type { FlagRule, SpecialistContext } from "../src/types.js";

const SPECIALIST: SpecialistContext = {
  specialistId: "005000000000001AAA",
  role: "SPECIALIST",
};
const SUPERVISOR: SpecialistContext = {
  specialistId: "005000000000002AAA",
  role: "SUPERVISOR",
};

describe("evaluateRule", () => {
  it("a disabled rule is OFF for everyone", () => {
    expect(evaluateRule({ enabled: false }, SPECIALIST)).toEqual({
      enabled: false,
      variant: null,
    });
  });

  it("an enabled rule with no targeting is ON for everyone", () => {
    expect(evaluateRule({ enabled: true }, SPECIALIST).enabled).toBe(true);
    expect(evaluateRule({ enabled: true }, SUPERVISOR).enabled).toBe(true);
  });

  it("an enabled rule targets a specialist by Salesforce User ID", () => {
    const rule: FlagRule = {
      enabled: true,
      targetSpecialistIds: ["005000000000001AAA"],
    };
    expect(evaluateRule(rule, SPECIALIST).enabled).toBe(true);
    expect(evaluateRule(rule, SUPERVISOR).enabled).toBe(false);
  });

  it("an enabled rule targets by role", () => {
    const rule: FlagRule = { enabled: true, targetRoles: ["SUPERVISOR"] };
    expect(evaluateRule(rule, SUPERVISOR).enabled).toBe(true);
    expect(evaluateRule(rule, SPECIALIST).enabled).toBe(false);
  });

  it("returns the variant only when the flag resolves ON", () => {
    const rule: FlagRule = {
      enabled: true,
      targetSpecialistIds: ["005000000000001AAA"],
      variant: "treatment",
    };
    expect(evaluateRule(rule, SPECIALIST).variant).toBe("treatment");
    expect(evaluateRule(rule, SUPERVISOR).variant).toBe(null);
  });
});

describe("parseFlagRule", () => {
  it("parses a well-formed rule", () => {
    expect(
      parseFlagRule(
        { enabled: true, targetRoles: ["SPECIALIST"], variant: "v1" },
        "test",
      ),
    ).toEqual({ enabled: true, targetRoles: ["SPECIALIST"], variant: "v1" });
  });

  it("throws when the rule is not an object", () => {
    expect(() => parseFlagRule(42, "test")).toThrow(/test/);
  });

  it("throws when enabled is missing or not a boolean", () => {
    expect(() => parseFlagRule({}, "test")).toThrow(/enabled/);
    expect(() => parseFlagRule({ enabled: "yes" }, "test")).toThrow(/enabled/);
  });

  it("throws when a target list is not an array of strings", () => {
    expect(() =>
      parseFlagRule({ enabled: true, targetSpecialistIds: "005..." }, "test"),
    ).toThrow(/targetSpecialistIds/);
  });

  it("ignores unknown keys (forward-compatible)", () => {
    expect(parseFlagRule({ enabled: false, futureKnob: 1 }, "test")).toEqual({
      enabled: false,
    });
  });
});
