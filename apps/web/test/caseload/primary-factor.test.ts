import { describe, expect, it } from "vitest";

import type { CaseloadItem } from "@anthos/api";

import { primaryFactorLabel } from "../../app/_components/participant/primary-factor";

function makeItem(overrides: Partial<CaseloadItem> = {}): CaseloadItem {
  return {
    participantId: "a015g00000ABCDxQAO",
    displayName: null,
    peLabel: null,
    programCode: null,
    aftercareDay: 200,
    aftercareStartDate: null,
    tier: 2,
    tierLabel: "Act this week",
    priorityScore: 42.5,
    priorityModifier: null,
    highestImpactFactor: {
      key: "days_since_last_contact",
      name: "Days since last successful contact",
      valueLabel: "16 days",
      weight: "1.5×",
      pointsContributed: 24.0,
    },
    factors: [],
    secondaryFactorLabel: null,
    triggered_invariants: [],
    lastSuccessfulContactDaysAgo: 16,
    stabilityVisit: {
      status: "on_track",
      statusLabel: "On track",
      nextDueDate: null,
      checkpoint: null,
      completedCount: 2,
      missedCount: 0,
      scheduledVisitDateTime: null,
    },
    cycleStatus: {
      state: "due",
      daysToNext: 7,
      daysOverdue: 0,
      nextCheckpoint: 90,
      lastCreditedCheckpoint: null,
    },
    perCheckpointBreakdown: [],
    openBarriers: [],
    tags: [],
    aftercareExtended: false,
    pathCSuppression: null,
    voucherRecertDays: null,
    dataIssues: [],
    ...overrides,
  };
}

// The function is now structurally typed; adapt CaseloadItem at the test
// boundary so the suite still reads against a realistic wire row.
function labelOf(item: CaseloadItem): string {
  return primaryFactorLabel({
    highestImpactFactor: item.highestImpactFactor,
    triggeredInvariants: item.triggered_invariants,
  });
}

describe("primaryFactorLabel — EC-12 for CaseloadItem", () => {
  it("returns the highest-impact factor name when no invariants fired", () => {
    expect(labelOf(makeItem())).toBe("Days since last successful contact");
  });

  it("falls through to '—' when no invariants and no highest factor", () => {
    expect(labelOf(makeItem({ highestImpactFactor: null }))).toBe("—");
  });

  it("returns the display_label of the first triggered invariant", () => {
    expect(
      labelOf(
        makeItem({
          triggered_invariants: [
            {
              invariant_id: "INV_REPAIR",
              display_label: "Open repair",
              triggering_record_id: "a0xx",
            },
          ],
        }),
      ),
    ).toBe("Open repair");
  });

  it("prefers invariant over highest factor when both are present (EC-12)", () => {
    expect(
      labelOf(
        makeItem({
          triggered_invariants: [
            {
              invariant_id: "INV_X",
              display_label: "Invariant X label",
            },
          ],
        }),
      ),
    ).toBe("Invariant X label");
  });

  it("picks the first entry when multiple invariants fired (EC-13)", () => {
    expect(
      labelOf(
        makeItem({
          triggered_invariants: [
            { invariant_id: "INV_A", display_label: "First label" },
            { invariant_id: "INV_B", display_label: "Second label" },
          ],
        }),
      ),
    ).toBe("First label");
  });
});
