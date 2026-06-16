import { describe, expect, it } from "vitest";

import { FeatureFlagClient } from "../src/client.js";
import { ENV_EDGE_CONFIG } from "../src/config.js";
import { selectFeatureFlagProvider } from "../src/provider-selector.js";
import { EdgeConfigFeatureFlagProvider } from "../src/providers/edge-config-provider.js";
import { LocalFeatureFlagProvider } from "../src/providers/local-provider.js";
import type { FlagRule, SpecialistContext } from "../src/types.js";

const SPECIALIST: SpecialistContext = {
  specialistId: "005000000000001AAA",
  role: "SPECIALIST",
};

describe("selectFeatureFlagProvider", () => {
  it("selects the Edge Config provider when EDGE_CONFIG is set", () => {
    const provider = selectFeatureFlagProvider({
      [ENV_EDGE_CONFIG]: "edge-config-connection-string-placeholder",
    });
    expect(provider).toBeInstanceOf(EdgeConfigFeatureFlagProvider);
  });

  it("falls back to the local provider when EDGE_CONFIG is absent", () => {
    expect(selectFeatureFlagProvider({})).toBeInstanceOf(
      LocalFeatureFlagProvider,
    );
  });

  it("a client yields identical results across swapped providers", async () => {
    // The same flag data behind either adapter must produce the same
    // evaluation — the swappable-adapter guarantee: feature code, which holds
    // only a FeatureFlagClient, never sees which provider is underneath.
    const rule: FlagRule = {
      enabled: true,
      targetSpecialistIds: ["005000000000001AAA"],
      variant: "on",
    };
    const local = new FeatureFlagClient(
      new LocalFeatureFlagProvider(new Map([["feature.x", rule]])),
    );
    const edge = new FeatureFlagClient(
      new EdgeConfigFeatureFlagProvider({
        readImpl: async () => ({ "feature.x": rule }),
      }),
    );

    expect(await local.isEnabled("feature.x", SPECIALIST)).toBe(true);
    expect(await edge.isEnabled("feature.x", SPECIALIST)).toBe(true);
    expect(await local.getVariant("feature.x", SPECIALIST)).toBe("on");
    expect(await edge.getVariant("feature.x", SPECIALIST)).toBe("on");
  });
});
