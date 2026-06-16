import { afterEach, describe, expect, it, vi } from "vitest";

import { FeatureFlagClient } from "../src/client.js";
import type {
  FeatureFlagProvider,
  SpecialistContext,
} from "../src/types.js";

const SPECIALIST: SpecialistContext = {
  specialistId: "005000000000001AAA",
  role: "SPECIALIST",
};

// A fake provider — the client is tested in isolation from any vendor.
function stubProvider(
  evaluate: FeatureFlagProvider["evaluate"],
): FeatureFlagProvider {
  return { evaluate };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("FeatureFlagClient", () => {
  it("isEnabled returns the provider's boolean for a known flag", async () => {
    const client = new FeatureFlagClient(
      stubProvider(async () => ({ enabled: true, variant: null })),
    );
    expect(await client.isEnabled("feature.x", SPECIALIST)).toBe(true);
  });

  it("getVariant returns the variant for an ON flag, null for an OFF flag", async () => {
    const on = new FeatureFlagClient(
      stubProvider(async () => ({ enabled: true, variant: "treatment" })),
    );
    const off = new FeatureFlagClient(
      stubProvider(async () => ({ enabled: false, variant: "treatment" })),
    );
    expect(await on.getVariant("feature.x", SPECIALIST)).toBe("treatment");
    expect(await off.getVariant("feature.x", SPECIALIST)).toBe(null);
  });

  it("an unknown flag key returns OFF and warns — never throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = new FeatureFlagClient(stubProvider(async () => null));

    expect(await client.isEnabled("feature.missing", SPECIALIST)).toBe(false);
    expect(await client.getVariant("feature.missing", SPECIALIST)).toBe(null);

    expect(warn).toHaveBeenCalled();
    const payload = JSON.parse(String(warn.mock.calls[0]?.[0]));
    expect(payload.event).toBe("feature_flags.unknown_flag");
    expect(payload.flagKey).toBe("feature.missing");
    // PII-free: the role is logged, the Salesforce User ID is not.
    expect(payload.role).toBe("SPECIALIST");
    expect(payload).not.toHaveProperty("specialistId");
  });

  it("a provider that throws fails closed to OFF with a structured error log", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = new FeatureFlagClient(
      stubProvider(async () => {
        throw new Error("edge config unreachable");
      }),
    );

    expect(await client.isEnabled("feature.x", SPECIALIST)).toBe(false);
    expect(await client.getVariant("feature.x", SPECIALIST)).toBe(null);

    const payload = JSON.parse(String(warn.mock.calls[0]?.[0]));
    expect(payload.event).toBe("feature_flags.evaluation_error");
    expect(payload).not.toHaveProperty("specialistId");
  });
});
