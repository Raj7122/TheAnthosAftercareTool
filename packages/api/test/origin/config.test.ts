import { describe, expect, it } from "vitest";

import { DEFAULT_ALLOWED_ORIGINS, loadOriginConfig } from "../../src/origin/config.js";

describe("loadOriginConfig", () => {
  it("defaults to localhost:3000 when ANTHOS_ALLOWED_ORIGINS is unset", () => {
    expect(loadOriginConfig({}).allowedOrigins).toEqual(DEFAULT_ALLOWED_ORIGINS);
  });

  it("defaults when the var is present but blank", () => {
    expect(loadOriginConfig({ ANTHOS_ALLOWED_ORIGINS: "   " }).allowedOrigins).toEqual(
      DEFAULT_ALLOWED_ORIGINS,
    );
  });

  it("reads the allowlist from ANTHOS_ALLOWED_ORIGINS — not hardcoded", () => {
    expect(
      loadOriginConfig({
        ANTHOS_ALLOWED_ORIGINS: "https://a.example,https://b.example",
      }).allowedOrigins,
    ).toEqual(["https://a.example", "https://b.example"]);
  });

  it("parses a whitespace-separated list and strips trailing slashes", () => {
    expect(
      loadOriginConfig({
        ANTHOS_ALLOWED_ORIGINS: "https://a.example/  https://b.example",
      }).allowedOrigins,
    ).toEqual(["https://a.example", "https://b.example"]);
  });

  it("resolves a comma-only garbage value to an empty allowlist — fails closed", () => {
    expect(loadOriginConfig({ ANTHOS_ALLOWED_ORIGINS: " , , " }).allowedOrigins).toEqual([]);
  });
});
