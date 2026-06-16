import type { CaseloadItem } from "@anthos/api";
import { describe, expect, it } from "vitest";

import { computeDiff } from "../../app/caseload/_lib/diff-caseload";

const P1 = "a015g00000ABCDxQAO";
const P2 = "a015g00000XYZyQAO";
const P3 = "a015g00000NEWzQAO";

function makeItem(overrides: Partial<CaseloadItem> = {}): CaseloadItem {
  const base: CaseloadItem = {
    participantId: P1,
    displayName: null,
    peLabel: null,
    programCode: null,
    aftercareDay: 100,
    aftercareStartDate: null,
    tier: 2,
    tierLabel: "Act this week",
    priorityScore: 42.5,
    priorityModifier: null,
    highestImpactFactor: {
      key: "days_since_last_contact",
      name: "Days since last successful contact",
      valueLabel: "8 days",
      weight: "×1.5",
      pointsContributed: 12,
    },
    factors: [
      {
        key: "days_since_last_contact",
        name: "Days since last successful contact",
        valueLabel: "8 days",
        valueNumeric: 8,
        weight: "×1.5",
        pointsContributed: 12,
      },
    ],
    secondaryFactorLabel: null,
    triggered_invariants: [],
    lastSuccessfulContactDaysAgo: 8,
    stabilityVisit: {
      status: "on_track",
      statusLabel: "On track",
      nextDueDate: null,
      checkpoint: null,
      completedCount: null,
      missedCount: null,
      scheduledVisitDateTime: null,
    },
    cycleStatus: {
      state: "between",
      daysToNext: null,
      daysOverdue: 0,
      nextCheckpoint: null,
      lastCreditedCheckpoint: null,
    },
    perCheckpointBreakdown: [],
    openBarriers: [],
    tags: [],
    aftercareExtended: false,
    pathCSuppression: null,
    voucherRecertDays: null,
    dataIssues: [],
  };
  return { ...base, ...overrides };
}

describe("computeDiff", () => {
  it("returns an empty set when items are identical", () => {
    const prev = [makeItem(), makeItem({ participantId: P2, tier: 1 })];
    const next = [makeItem(), makeItem({ participantId: P2, tier: 1 })];
    expect(Array.from(computeDiff(prev, next))).toEqual([]);
  });

  it("flags a row whose tier changed", () => {
    const prev = [makeItem({ tier: 2, tierLabel: "Act this week" })];
    const next = [makeItem({ tier: 1, tierLabel: "Act today" })];
    expect(Array.from(computeDiff(prev, next))).toEqual([P1]);
  });

  it("flags a row whose priority score changed", () => {
    const prev = [makeItem({ priorityScore: 42.5 })];
    const next = [makeItem({ priorityScore: 47.0 })];
    expect(Array.from(computeDiff(prev, next))).toEqual([P1]);
  });

  it("flags a row whose primary factor name changed (highest-impact path)", () => {
    const prev = [
      makeItem({
        highestImpactFactor: {
          key: "days_since_last_contact",
          name: "Days since last successful contact",
          valueLabel: "8 days",
          weight: "×1.5",
          pointsContributed: 12,
        },
      }),
    ];
    const next = [
      makeItem({
        highestImpactFactor: {
          key: "voucher_recert_deadline",
          name: "Voucher recertification pending",
          valueLabel: "in 5 days",
          weight: "×2.0",
          pointsContributed: 20,
        },
      }),
    ];
    expect(Array.from(computeDiff(prev, next))).toEqual([P1]);
  });

  it("flags a row when a triggered invariant displaces the highest-impact label (EC-12)", () => {
    // Same engine core (tier/score/factor) but a new triggered_invariant
    // takes over the primary-factor label — the diff must catch it because
    // the row's visible "primary factor" line is what the specialist reads.
    const prev = [makeItem()];
    const next = [
      makeItem({
        triggered_invariants: [
          {
            invariant_id: "INV_NO_RECENT_CONTACT",
            display_label: "No contact ≥21 days",
          },
        ],
      }),
    ];
    expect(Array.from(computeDiff(prev, next))).toEqual([P1]);
  });

  it("does NOT flag position-only re-sorts (same tier/score/factor)", () => {
    const a = makeItem({ participantId: P1, priorityScore: 30 });
    const b = makeItem({ participantId: P2, priorityScore: 50 });
    const prev = [a, b];
    const next = [b, a]; // swapped order, same engine values
    expect(Array.from(computeDiff(prev, next))).toEqual([]);
  });

  it("flags a participant newly present in the queue", () => {
    const prev = [makeItem({ participantId: P1 })];
    const next = [
      makeItem({ participantId: P1 }),
      makeItem({ participantId: P3 }),
    ];
    expect(Array.from(computeDiff(prev, next))).toEqual([P3]);
  });

  it("does not return removed participants (nothing to highlight)", () => {
    const prev = [
      makeItem({ participantId: P1 }),
      makeItem({ participantId: P2 }),
    ];
    const next = [makeItem({ participantId: P1 })];
    expect(Array.from(computeDiff(prev, next))).toEqual([]);
  });

  it("treats null engine fields as comparable values (degraded row stays unflagged)", () => {
    const prev = [
      makeItem({
        tier: null,
        tierLabel: null,
        priorityScore: null,
        highestImpactFactor: null,
        dataIssues: ["degraded_score"],
      }),
    ];
    const next = [
      makeItem({
        tier: null,
        tierLabel: null,
        priorityScore: null,
        highestImpactFactor: null,
        dataIssues: ["degraded_score"],
      }),
    ];
    expect(Array.from(computeDiff(prev, next))).toEqual([]);
  });
});
