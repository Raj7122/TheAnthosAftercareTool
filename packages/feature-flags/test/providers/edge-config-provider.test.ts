import { describe, expect, it, vi } from "vitest";

import {
  EDGE_CONFIG_FLAGS_ITEM,
  EdgeConfigFeatureFlagProvider,
  type EdgeConfigReader,
} from "../../src/providers/edge-config-provider.js";
import type { SpecialistContext } from "../../src/types.js";

const SPECIALIST: SpecialistContext = {
  specialistId: "005000000000001AAA",
  role: "SPECIALIST",
};

// A fake Edge Config reader — the provider runs with no connection string and
// no network. The reader ignores the item key and returns a fixed payload.
function fixedReader(item: unknown): EdgeConfigReader {
  return async () => item;
}

describe("EdgeConfigFeatureFlagProvider", () => {
  it("returns null when the flags item is absent", async () => {
    const p = new EdgeConfigFeatureFlagProvider({
      readImpl: fixedReader(undefined),
    });
    expect(await p.evaluate("feature.calibration", SPECIALIST)).toBe(null);
  });

  it("returns null when the flag key is not present in the item", async () => {
    const p = new EdgeConfigFeatureFlagProvider({
      readImpl: fixedReader({ "feature.other": { enabled: true } }),
    });
    expect(await p.evaluate("feature.calibration", SPECIALIST)).toBe(null);
  });

  it("evaluates a present rule against the specialist context", async () => {
    const p = new EdgeConfigFeatureFlagProvider({
      readImpl: fixedReader({
        "feature.calibration": {
          enabled: true,
          targetSpecialistIds: ["005000000000001AAA"],
          variant: "calibration-ui",
        },
      }),
    });
    expect(await p.evaluate("feature.calibration", SPECIALIST)).toEqual({
      enabled: true,
      variant: "calibration-ui",
    });
  });

  it("reads flags from the single featureFlags item", async () => {
    const read = vi.fn(async () => ({}));
    const p = new EdgeConfigFeatureFlagProvider({ readImpl: read });
    await p.evaluate("feature.calibration", SPECIALIST);
    expect(read).toHaveBeenCalledWith(EDGE_CONFIG_FLAGS_ITEM);
  });

  it("throws when the flags item is not an object", async () => {
    const p = new EdgeConfigFeatureFlagProvider({
      readImpl: fixedReader("not-an-object"),
    });
    await expect(
      p.evaluate("feature.calibration", SPECIALIST),
    ).rejects.toThrow(EDGE_CONFIG_FLAGS_ITEM);
  });

  it("throws when a present rule is malformed", async () => {
    const p = new EdgeConfigFeatureFlagProvider({
      readImpl: fixedReader({ "feature.calibration": { enabled: "yes" } }),
    });
    await expect(
      p.evaluate("feature.calibration", SPECIALIST),
    ).rejects.toThrow(/enabled/);
  });
});
