import { KNOWN_BARRIER_TYPES } from "@anthos/integrations";
import { describe, expect, it } from "vitest";

import {
  classifyBarrierSeverity,
  type BarrierSeverityClassification,
} from "../../src/barriers/severity.js";

// Anchors the FS v1.12 §F-06 BR-37 [PROPOSED] coarse three-tier mapping (lines
// 717–721 of FS_v1_12.md). The test asserts every one of the 27 known Barrier
// Types maps to a defined tier — adding a Type to `picklist-cache.ts` without
// updating `severity.ts` should fail this test, not silently default.

describe("classifyBarrierSeverity — BR-37 table", () => {
  it("maps every known SF Barrier Type to a defined tier", () => {
    const undefinedTypes: string[] = [];
    for (const type of KNOWN_BARRIER_TYPES) {
      if (classifyBarrierSeverity(type) === null) {
        undefinedTypes.push(type);
      }
    }
    expect(undefinedTypes).toEqual([]);
  });

  // One assertion per tier — guards against drift on the specific high-impact
  // Types Marie called out in calibration (BR-22, BR-37).
  it.each<[string, BarrierSeverityClassification]>([
    ["Domestic Violence", "high"],
    ["Cannot reach participant", "high"],
    ["Personal or medical emergency", "high"],
    ["Concerning behavior", "high"],
    ["Medical/Mental Health Emergency", "high"],
    ["Arrears (rent or utilities)", "medium"],
    ["Legal issues", "medium"],
    ["Mobility issue", "medium"],
    ["Transportation issue", "medium"],
    ["PA issue", "low"],
    ["Documentation issue", "low"],
    ["Bad credit", "low"],
    ["Banked units do not match needs", "out_of_scope"],
    ["No show to viewings", "out_of_scope"],
  ])("classifies %s → %s", (type, expected) => {
    expect(classifyBarrierSeverity(type)).toBe(expected);
  });

  it("returns null for an unknown Type (e.g. Habitability / building condition is pending picklist extension)", () => {
    expect(classifyBarrierSeverity("Habitability / building condition")).toBe(
      null,
    );
    expect(classifyBarrierSeverity("not a real barrier type")).toBe(null);
  });
});
