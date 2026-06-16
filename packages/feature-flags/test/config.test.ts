import { describe, expect, it } from "vitest";

import { ENV_FEATURE_FLAGS, loadFeatureFlagsConfig } from "../src/config.js";

describe("loadFeatureFlagsConfig", () => {
  it("returns an empty map when the env var is absent", () => {
    expect(loadFeatureFlagsConfig({}).size).toBe(0);
  });

  it("returns an empty map when the env var is blank", () => {
    expect(loadFeatureFlagsConfig({ [ENV_FEATURE_FLAGS]: "   " }).size).toBe(0);
  });

  it("parses a JSON map of flag key -> rule", () => {
    const rules = loadFeatureFlagsConfig({
      [ENV_FEATURE_FLAGS]: JSON.stringify({
        "feature.m_ai.summary": {
          enabled: true,
          targetSpecialistIds: ["005000000000001AAA"],
        },
      }),
    });
    expect(rules.get("feature.m_ai.summary")).toEqual({
      enabled: true,
      targetSpecialistIds: ["005000000000001AAA"],
    });
  });

  it("throws on malformed JSON, naming the env var", () => {
    expect(() =>
      loadFeatureFlagsConfig({ [ENV_FEATURE_FLAGS]: "{not json" }),
    ).toThrow(ENV_FEATURE_FLAGS);
  });

  it("throws when the payload is not a JSON object", () => {
    expect(() => loadFeatureFlagsConfig({ [ENV_FEATURE_FLAGS]: "[]" })).toThrow(
      ENV_FEATURE_FLAGS,
    );
  });

  it("throws when a nested rule is malformed", () => {
    expect(() =>
      loadFeatureFlagsConfig({
        [ENV_FEATURE_FLAGS]: JSON.stringify({ bad: { enabled: "nope" } }),
      }),
    ).toThrow(/enabled/);
  });
});
