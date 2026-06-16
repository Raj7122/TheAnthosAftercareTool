import { describe, expect, it } from "vitest";

import {
  buildFrameAncestorsCsp,
  DEFAULT_FRAME_ANCESTORS,
  loadCspConfig,
} from "../../lib/csp";

describe("loadCspConfig", () => {
  it("defaults to the API §8 Salesforce allowlist when the env var is unset", () => {
    expect(loadCspConfig({}).frameAncestors).toBe(DEFAULT_FRAME_ANCESTORS);
  });

  it("defaults when the env var is present but blank", () => {
    expect(loadCspConfig({ ANTHOS_CSP_FRAME_ANCESTORS: "  " }).frameAncestors).toBe(
      DEFAULT_FRAME_ANCESTORS,
    );
  });

  it("reads the allowlist from ANTHOS_CSP_FRAME_ANCESTORS — proves it is not hardcoded", () => {
    const tightened = "https://anthoshome3.lightning.force.com";
    expect(
      loadCspConfig({ ANTHOS_CSP_FRAME_ANCESTORS: tightened }).frameAncestors,
    ).toBe(tightened);
  });

  it("collapses whitespace in a multi-origin value", () => {
    expect(
      loadCspConfig({
        ANTHOS_CSP_FRAME_ANCESTORS: "https://a.example   https://b.example",
      }).frameAncestors,
    ).toBe("https://a.example https://b.example");
  });
});

describe("buildFrameAncestorsCsp", () => {
  it("emits a frame-ancestors directive", () => {
    expect(buildFrameAncestorsCsp({ frameAncestors: "https://x.example" })).toBe(
      "frame-ancestors https://x.example",
    );
  });

  it("carries the default Salesforce allowlist end-to-end", () => {
    expect(buildFrameAncestorsCsp(loadCspConfig({}))).toBe(
      `frame-ancestors ${DEFAULT_FRAME_ANCESTORS}`,
    );
  });
});
