import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isAllowed } from "../../app/calibration/_lib/access";

describe("isAllowed", () => {
  const original = process.env["CALIBRATION_ALLOWLIST"];

  beforeEach(() => {
    delete process.env["CALIBRATION_ALLOWLIST"];
  });
  afterEach(() => {
    if (original === undefined) delete process.env["CALIBRATION_ALLOWLIST"];
    else process.env["CALIBRATION_ALLOWLIST"] = original;
  });

  it("returns false when identity is null", () => {
    process.env["CALIBRATION_ALLOWLIST"] = "erik@anthos.org";
    expect(isAllowed(null)).toBe(false);
  });

  it("returns false when identity is empty string", () => {
    process.env["CALIBRATION_ALLOWLIST"] = "erik@anthos.org";
    expect(isAllowed("")).toBe(false);
  });

  it("returns false when env var is unset", () => {
    expect(isAllowed("erik@anthos.org")).toBe(false);
  });

  it("returns false when env var is empty after trimming", () => {
    process.env["CALIBRATION_ALLOWLIST"] = " , , ";
    expect(isAllowed("erik@anthos.org")).toBe(false);
  });

  it("matches identity case-insensitively", () => {
    process.env["CALIBRATION_ALLOWLIST"] = "Erik@Anthos.Org";
    expect(isAllowed("erik@anthos.org")).toBe(true);
    expect(isAllowed("ERIK@ANTHOS.ORG")).toBe(true);
  });

  it("trims whitespace around list entries and queries", () => {
    process.env["CALIBRATION_ALLOWLIST"] = " marie@anthos.org , erik@anthos.org ";
    expect(isAllowed("erik@anthos.org")).toBe(true);
    expect(isAllowed("  marie@anthos.org  ")).toBe(true);
  });

  it("returns false for identity not in list", () => {
    process.env["CALIBRATION_ALLOWLIST"] = "marie@anthos.org,erik@anthos.org";
    expect(isAllowed("stranger@anthos.org")).toBe(false);
  });

  it("ignores blank entries in the allowlist", () => {
    process.env["CALIBRATION_ALLOWLIST"] = ",,erik@anthos.org,,";
    expect(isAllowed("erik@anthos.org")).toBe(true);
  });
});
