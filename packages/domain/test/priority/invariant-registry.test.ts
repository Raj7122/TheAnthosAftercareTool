import { describe, expect, it } from "vitest";

import type { Configuration } from "../../src/config/index.js";
import {
  ConfigValidationError,
  getActiveInvariants,
} from "../../src/priority/index.js";
import { makeConfig } from "./_fixtures.js";

// P0-10a — NEW (v1.2). Fail-loud + construction matrix for
// `getActiveInvariants`, the engine-boot step that assembles the active
// TierInvariant set from the M-CONFIG `tierInvariants` block (BR-24/25/26).
//
// The critical case: an invariant config that references a Barrier Type absent
// from the Salesforce picklist enum cache MUST make the engine refuse to boot
// (VR-08 / TR-PRIORITY-17). A picklist edit that silently drops a mapped Type
// would otherwise ship calibration drift to specialists undetected. BR-25
// (P0-04e) reads `Repair__c`, not the Barrier Type picklist, so it carries no
// enum-cache check — covered explicitly below.

// invariantConfig — Configuration with an explicit `tierInvariants` block.
// makeConfig's default block is Demo-Mode dark (high threshold, empty mapping);
// these tests drive specific BR-25/26 wiring.
function invariantConfig(
  overrides: Partial<Configuration["tierInvariants"]> = {},
): Configuration {
  return makeConfig({
    tierInvariants: {
      failed_attempts_tier1_threshold: 3,
      barrier_type_to_invariant: {},
      open_repair_invariant: null,
      invariant_override_suppression: true,
      ...overrides,
    },
  });
}

const HABITABILITY_TYPE = "Habitability / building condition";

describe("getActiveInvariants — fail-loud on unknown Barrier Type (AC-15, VR-08)", () => {
  it("throws ConfigValidationError when a mapped Barrier Type is absent from the enum cache", () => {
    const config = invariantConfig({
      barrier_type_to_invariant: {
        [HABITABILITY_TYPE]: {
          invariant_id: "BR-26",
          display_label: "Habitability Barrier",
        },
      },
    });

    expect(() => getActiveInvariants(config, new Set<string>())).toThrowError(
      ConfigValidationError,
    );
  });

  it("names the offending Type, configuration version, and invariant id in error.details", () => {
    const config = invariantConfig({
      barrier_type_to_invariant: {
        [HABITABILITY_TYPE]: {
          invariant_id: "BR-26",
          display_label: "Habitability Barrier",
        },
      },
    });

    try {
      getActiveInvariants(config, new Set<string>());
      expect.fail("expected getActiveInvariants to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigValidationError);
      const e = err as ConfigValidationError;
      expect(e.code).toBe("VR_08_UNKNOWN_BARRIER_TYPE");
      expect(e.details["barrierType"]).toBe(HABITABILITY_TYPE);
      expect(e.details["configurationVersion"]).toBe(config.version);
      expect(e.details["invariantId"]).toBe("BR-26");
    }
  });

  it("throws when the enum cache is empty but a mapping is configured", () => {
    const config = invariantConfig({
      barrier_type_to_invariant: {
        "Some Barrier Type": {
          invariant_id: "BR-26",
          display_label: "X",
        },
      },
    });
    expect(() => getActiveInvariants(config, new Set())).toThrowError(
      ConfigValidationError,
    );
  });
});

describe("getActiveInvariants — clean construction", () => {
  it("boots cleanly when every mapped Barrier Type is present in the enum cache", () => {
    const invariants = getActiveInvariants(
      invariantConfig({
        barrier_type_to_invariant: {
          [HABITABILITY_TYPE]: {
            invariant_id: "BR-26",
            display_label: "Habitability Barrier",
          },
        },
      }),
      new Set([HABITABILITY_TYPE]),
    );
    expect(invariants.map((i) => i.id)).toEqual(["BR-24", "BR-26"]);
  });

  it("constructs only BR-24 in Demo Mode posture (empty mapping, null open-repair block)", () => {
    const invariants = getActiveInvariants(invariantConfig(), new Set());
    expect(invariants.map((i) => i.id)).toEqual(["BR-24"]);
  });

  it("constructs BR-25 from the open_repair_invariant block with no enum-cache dependency", () => {
    // BR-25 (P0-04e) reads Repair__c — it is NOT in barrier_type_to_invariant
    // and an empty enum cache must not block it.
    const invariants = getActiveInvariants(
      invariantConfig({
        open_repair_invariant: {
          invariant_id: "BR-25",
          display_label: "Open Repair",
        },
      }),
      new Set(),
    );
    expect(invariants.map((i) => i.id)).toEqual(["BR-24", "BR-25"]);
  });

  it("orders the active set BR-24, BR-25, then BR-26 entries (TR-PRIORITY-4 determinism)", () => {
    const invariants = getActiveInvariants(
      invariantConfig({
        barrier_type_to_invariant: {
          [HABITABILITY_TYPE]: {
            invariant_id: "BR-26",
            display_label: "Habitability Barrier",
          },
        },
        open_repair_invariant: {
          invariant_id: "BR-25",
          display_label: "Open Repair",
        },
      }),
      new Set([HABITABILITY_TYPE]),
    );
    // Order is load-bearing — assert the array, not a sort.
    expect(invariants.map((i) => i.id)).toEqual(["BR-24", "BR-25", "BR-26"]);
  });
});
