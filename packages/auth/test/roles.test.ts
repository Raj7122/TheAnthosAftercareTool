import { describe, expect, it } from "vitest";

import { computePermissionsHash, isAdmin, isRole } from "../src/roles.js";

const SPECIALIST_ID = "0058K00000XYZAbQAO";

describe("isRole", () => {
  it("accepts the four canonical role strings", () => {
    for (const role of ["SPECIALIST", "SUPERVISOR", "VP", "SYSTEM_ADMIN"]) {
      expect(isRole(role)).toBe(true);
    }
  });

  it("rejects a non-role value", () => {
    expect(isRole("specialist")).toBe(false);
    expect(isRole(42)).toBe(false);
  });
});

describe("isAdmin", () => {
  it("is true only for SYSTEM_ADMIN (BR-13)", () => {
    expect(isAdmin("SYSTEM_ADMIN")).toBe(true);
    expect(isAdmin("VP")).toBe(false);
    expect(isAdmin("SPECIALIST")).toBe(false);
  });
});

describe("computePermissionsHash", () => {
  it("returns a sha256-prefixed 64-hex digest", () => {
    expect(computePermissionsHash(SPECIALIST_ID, "SPECIALIST")).toMatch(
      /^sha256:[a-f0-9]{64}$/,
    );
  });

  it("is deterministic for the same specialist + role", () => {
    expect(computePermissionsHash(SPECIALIST_ID, "VP")).toBe(
      computePermissionsHash(SPECIALIST_ID, "VP"),
    );
  });

  it("changes when the role changes — the EC-02 mid-session signal", () => {
    expect(computePermissionsHash(SPECIALIST_ID, "SPECIALIST")).not.toBe(
      computePermissionsHash(SPECIALIST_ID, "SUPERVISOR"),
    );
  });

  it("is distinct per specialist for the same role", () => {
    expect(computePermissionsHash("0058K00000AAAAAQAO", "SPECIALIST")).not.toBe(
      computePermissionsHash("0058K00000BBBBBQAO", "SPECIALIST"),
    );
  });
});
