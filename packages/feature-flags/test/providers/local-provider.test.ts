import { describe, expect, it } from "vitest";

import { LocalFeatureFlagProvider } from "../../src/providers/local-provider.js";
import type { FlagRule, SpecialistContext } from "../../src/types.js";

const SPECIALIST: SpecialistContext = {
  specialistId: "005000000000001AAA",
  role: "SPECIALIST",
};

function provider(
  rules: Record<string, FlagRule>,
): LocalFeatureFlagProvider {
  return new LocalFeatureFlagProvider(new Map(Object.entries(rules)));
}

describe("LocalFeatureFlagProvider", () => {
  it("returns null for an unknown flag key", async () => {
    expect(await provider({}).evaluate("feature.unknown", SPECIALIST)).toBe(
      null,
    );
  });

  it("evaluates a targeted specialist as ON", async () => {
    const p = provider({
      "feature.calibration": {
        enabled: true,
        targetSpecialistIds: ["005000000000001AAA"],
      },
    });
    expect(await p.evaluate("feature.calibration", SPECIALIST)).toEqual({
      enabled: true,
      variant: null,
    });
  });

  it("evaluates an untargeted specialist as OFF", async () => {
    const p = provider({
      "feature.calibration": {
        enabled: true,
        targetSpecialistIds: ["005000000000999AAA"],
      },
    });
    expect(await p.evaluate("feature.calibration", SPECIALIST)).toEqual({
      enabled: false,
      variant: null,
    });
  });

  it("evaluates a role-targeted specialist as ON", async () => {
    const p = provider({
      "feature.calibration": { enabled: true, targetRoles: ["SPECIALIST"] },
    });
    expect(
      (await p.evaluate("feature.calibration", SPECIALIST))?.enabled,
    ).toBe(true);
  });
});
