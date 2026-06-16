import type { CaseloadItem, PriorityRecomputed } from "@anthos/api";
import { describe, expect, it } from "vitest";

import {
  applyOptimisticClose,
  applyOptimisticCreate,
  applyPriorityRecompute,
  replaceTempBarrier,
  rollbackToSnapshot,
  snapshotRow,
} from "../../app/caseload/_lib/caseload-mutations";

const P1 = "a015g00000ABCDxQAO";
const P2 = "a015g00000XYZyQAO";

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

// ── snapshotRow ─────────────────────────────────────────────────────────────

describe("snapshotRow", () => {
  it("returns the matching row reference, byte-for-byte", () => {
    const item = makeItem();
    const items = [item, makeItem({ participantId: P2 })];
    expect(snapshotRow(items, P1)).toBe(item);
  });

  it("returns null when the participant is not in view", () => {
    const items = [makeItem()];
    expect(snapshotRow(items, "missing")).toBeNull();
  });
});

// ── applyOptimisticCreate ───────────────────────────────────────────────────

describe("applyOptimisticCreate", () => {
  it("inserts an optimistic Barrier into the target row's openBarriers", () => {
    const items = [makeItem()];
    const next = applyOptimisticCreate(items, P1, {
      tempBarrierId: "optimistic:abc",
      type: "Domestic Violence",
      severity: null,
      openedAtIso: "2026-05-23T12:00:00Z",
    });
    expect(next[0]?.openBarriers).toEqual([
      {
        barrierId: "optimistic:abc",
        type: "Domestic Violence",
        severity: null,
        openedAt: "2026-05-23T12:00:00Z",
        ageDays: 0,
      },
    ]);
  });

  it("leaves other participants untouched", () => {
    const items = [makeItem(), makeItem({ participantId: P2 })];
    const next = applyOptimisticCreate(items, P1, {
      tempBarrierId: "optimistic:abc",
      type: "Domestic Violence",
      severity: null,
      openedAtIso: "2026-05-23T12:00:00Z",
    });
    expect(next[1]).toBe(items[1]);
  });

  it("appends to an existing openBarriers list rather than replacing it", () => {
    const existing = {
      barrierId: "real-1",
      type: "Arrears (rent or utilities)",
      severity: "medium" as const,
      openedAt: "2026-05-01T00:00:00Z",
      ageDays: 22,
    };
    const items = [makeItem({ openBarriers: [existing] })];
    const next = applyOptimisticCreate(items, P1, {
      tempBarrierId: "optimistic:abc",
      type: "Domestic Violence",
      severity: null,
      openedAtIso: "2026-05-23T12:00:00Z",
    });
    expect(next[0]?.openBarriers).toHaveLength(2);
    expect(next[0]?.openBarriers[0]).toBe(existing);
  });
});

// ── applyOptimisticClose ────────────────────────────────────────────────────

describe("applyOptimisticClose", () => {
  it("removes the closed Barrier from the target row only", () => {
    const items = [
      makeItem({
        openBarriers: [
          {
            barrierId: "b1",
            type: "Domestic Violence",
            severity: "high",
            openedAt: "2026-05-01T00:00:00Z",
            ageDays: 22,
          },
          {
            barrierId: "b2",
            type: "Arrears (rent or utilities)",
            severity: "medium",
            openedAt: "2026-05-10T00:00:00Z",
            ageDays: 13,
          },
        ],
      }),
    ];
    const next = applyOptimisticClose(items, P1, "b1");
    expect(next[0]?.openBarriers.map((b) => b.barrierId)).toEqual(["b2"]);
  });

  it("is a no-op when the Barrier id is not found", () => {
    const items = [makeItem({ openBarriers: [] })];
    const next = applyOptimisticClose(items, P1, "missing");
    expect(next[0]?.openBarriers).toEqual([]);
  });
});

// ── applyPriorityRecompute ──────────────────────────────────────────────────

describe("applyPriorityRecompute", () => {
  it("replaces tier / score / factors and derives tierLabel from tier (FS v1.12 §F-02)", () => {
    const items = [makeItem({ tier: 2, tierLabel: "Act this week", priorityScore: 42.5 })];
    const recompute: PriorityRecomputed = {
      participantId: P1,
      score: 91.2,
      tier: 1,
      factors: [
        {
          key: "open_barriers",
          name: "Open Barriers",
          valueLabel: "1 open",
          valueNumeric: 1,
          weight: "×3.0",
          pointsContributed: 30,
        },
      ],
      previousScore: 42.5,
      previousTier: 2,
    };
    const next = applyPriorityRecompute(items, recompute);
    expect(next[0]?.tier).toBe(1);
    expect(next[0]?.tierLabel).toBe("Act today");
    expect(next[0]?.priorityScore).toBe(91.2);
    expect(next[0]?.factors).toEqual([
      {
        key: "open_barriers",
        name: "Open Barriers",
        valueLabel: "1 open",
        valueNumeric: 1,
        weight: "×3.0",
        pointsContributed: 30,
      },
    ]);
  });

  it("leaves triggered_invariants + highestImpactFactor on the pre-write snapshot — recompute payload doesn't carry them", () => {
    const items = [
      makeItem({
        triggered_invariants: [
          { invariant_id: "failed_attempts_tier1", display_label: "Tier 1 — 3+ failed attempts" },
        ],
      }),
    ];
    const recompute: PriorityRecomputed = {
      participantId: P1,
      score: 91.2,
      tier: 1,
      factors: [],
      previousScore: null,
      previousTier: null,
    };
    const next = applyPriorityRecompute(items, recompute);
    expect(next[0]?.triggered_invariants).toEqual(items[0]?.triggered_invariants);
    expect(next[0]?.highestImpactFactor).toEqual(items[0]?.highestImpactFactor);
  });

  it("nulls tierLabel when the recompute tier is null (engine degraded row)", () => {
    const items = [makeItem({ tier: 1, tierLabel: "Act today" })];
    const recompute: PriorityRecomputed = {
      participantId: P1,
      score: null,
      tier: null,
      factors: [],
      previousScore: null,
      previousTier: null,
    };
    const next = applyPriorityRecompute(items, recompute);
    expect(next[0]?.tier).toBeNull();
    expect(next[0]?.tierLabel).toBeNull();
    expect(next[0]?.priorityScore).toBeNull();
  });

  it("leaves non-matching rows untouched", () => {
    const items = [makeItem(), makeItem({ participantId: P2 })];
    const recompute: PriorityRecomputed = {
      participantId: P1,
      score: 91.2,
      tier: 1,
      factors: [],
      previousScore: null,
      previousTier: null,
    };
    const next = applyPriorityRecompute(items, recompute);
    expect(next[1]).toBe(items[1]);
  });
});

// ── replaceTempBarrier ──────────────────────────────────────────────────────

describe("replaceTempBarrier", () => {
  it("swaps the optimistic Barrier for the canonical server-returned record", () => {
    const items = [
      makeItem({
        openBarriers: [
          {
            barrierId: "optimistic:abc",
            type: "Domestic Violence",
            severity: null,
            openedAt: "2026-05-23T12:00:00Z",
            ageDays: 0,
          },
        ],
      }),
    ];
    const next = replaceTempBarrier(items, P1, "optimistic:abc", {
      barrierId: "a0K5g00000XYZxQAO",
      type: "Domestic Violence",
      severity: "high",
      openedAt: "2026-05-23T12:00:01Z",
      ageDays: 0,
    });
    expect(next[0]?.openBarriers).toEqual([
      {
        barrierId: "a0K5g00000XYZxQAO",
        type: "Domestic Violence",
        severity: "high",
        openedAt: "2026-05-23T12:00:01Z",
        ageDays: 0,
      },
    ]);
  });

  it("is a no-op when the temp id is not present (e.g. queue switch occurred mid-flight)", () => {
    const items = [makeItem({ openBarriers: [] })];
    const next = replaceTempBarrier(items, P1, "optimistic:missing", {
      barrierId: "real-1",
      type: "Arrears (rent or utilities)",
      severity: "medium",
      openedAt: "2026-05-23T12:00:01Z",
      ageDays: 0,
    });
    expect(next[0]?.openBarriers).toEqual([]);
  });
});

// ── rollbackToSnapshot ──────────────────────────────────────────────────────

describe("rollbackToSnapshot", () => {
  it("restores the snapshot row byte-for-byte (Pattern A: don't roll back silently)", () => {
    const snapshot = makeItem({ tier: 2, priorityScore: 42.5 });
    const mutated = [
      makeItem({
        tier: 1,
        tierLabel: "Act today",
        priorityScore: 91.2,
        openBarriers: [
          {
            barrierId: "optimistic:abc",
            type: "Domestic Violence",
            severity: null,
            openedAt: "2026-05-23T12:00:00Z",
            ageDays: 0,
          },
        ],
      }),
    ];
    const next = rollbackToSnapshot(mutated, snapshot);
    expect(next[0]).toBe(snapshot);
  });

  it("leaves other rows untouched", () => {
    const other = makeItem({ participantId: P2, tier: 3 });
    const snapshot = makeItem({ tier: 2 });
    const mutated = [makeItem({ tier: 1 }), other];
    const next = rollbackToSnapshot(mutated, snapshot);
    expect(next[1]).toBe(other);
  });
});
