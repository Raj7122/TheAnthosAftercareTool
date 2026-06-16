import { describe, expect, it } from "vitest";

import type { CalibrationParticipantDTO } from "@anthos/api";

import { primaryFactorLabel } from "../../app/calibration/_lib/primary-factor";

function makeDto(
  overrides: Partial<CalibrationParticipantDTO> = {},
): CalibrationParticipantDTO {
  return {
    participantId: "001x",
    ownerId: "005x",
    hydratedAt: new Date(),
    scored: true,
    priorityScore: 42,
    tier: 2,
    tierLabel: "Tier 2",
    highestImpactFactor: {
      name: "Days since last contact",
      key: "days_since_last_contact",
      valueLabel: "12 days",
      weight: "10.00%",
      pointsContributed: 1.2,
    },
    factors: [],
    triggeredInvariants: [],
    triggeredCaps: [],
    configurationVersion: 1,
    ...overrides,
  };
}

describe("primaryFactorLabel — EC-12", () => {
  it("returns the highest-impact factor name when no invariants fired", () => {
    expect(primaryFactorLabel(makeDto())).toBe("Days since last contact");
  });

  it("falls through to '—' when no invariants and no highest factor", () => {
    expect(
      primaryFactorLabel(makeDto({ highestImpactFactor: null })),
    ).toBe("—");
  });

  it("returns the display_label of the first triggered invariant", () => {
    expect(
      primaryFactorLabel(
        makeDto({
          triggeredInvariants: [
            {
              invariant_id: "INV_REPAIR_BARRIER",
              display_label: "Open repair barrier ≥30 days",
              triggering_record_id: "a0Bxx",
            },
          ],
        }),
      ),
    ).toBe("Open repair barrier ≥30 days");
  });

  it("picks the first entry when multiple invariants fired (EC-12 'single repair barrier')", () => {
    expect(
      primaryFactorLabel(
        makeDto({
          triggeredInvariants: [
            {
              invariant_id: "INV_A",
              display_label: "First label",
              triggering_record_id: "r1",
            },
            {
              invariant_id: "INV_B",
              display_label: "Second label",
              triggering_record_id: "r2",
            },
          ],
        }),
      ),
    ).toBe("First label");
  });

  it("prefers invariant over highest factor when both are present", () => {
    expect(
      primaryFactorLabel(
        makeDto({
          triggeredInvariants: [
            {
              invariant_id: "INV_X",
              display_label: "Invariant X label",
              triggering_record_id: "rX",
            },
          ],
          highestImpactFactor: {
            name: "Some other factor",
            key: "k",
            valueLabel: "v",
            weight: "1.00%",
            pointsContributed: 99,
          },
        }),
      ),
    ).toBe("Invariant X label");
  });
});
