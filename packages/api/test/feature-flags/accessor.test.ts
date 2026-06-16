import { FeatureFlagClient } from "@anthos/feature-flags";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getFeatureFlagClient } from "../../src/feature-flags/index.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getFeatureFlagClient (BFF accessor)", () => {
  it("returns a FeatureFlagClient and reuses the same instance", () => {
    const client = getFeatureFlagClient();
    expect(client).toBeInstanceOf(FeatureFlagClient);
    expect(getFeatureFlagClient()).toBe(client);
  });

  it("resolves an unknown flag to OFF with no EDGE_CONFIG configured", async () => {
    // No EDGE_CONFIG / ANTHOS_FEATURE_FLAGS in the test env -> the selector
    // falls back to the local provider with an empty rule map, so every flag
    // key is unknown and fails closed. Proves the BFF wiring is live.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const enabled = await getFeatureFlagClient().isEnabled("feature.demo", {
      specialistId: "005000000000001AAA",
      role: "SPECIALIST",
    });
    expect(enabled).toBe(false);
  });
});
