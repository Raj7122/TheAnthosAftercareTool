import type { CaseloadItem, RowTag } from "@anthos/api";
import { describe, expect, it } from "vitest";

import {
  applySort,
  describeSort,
  DEFAULT_SORT,
  sortReducer,
  type SortState,
} from "../../app/caseload/_lib/caseload-sort";

function makeItem(overrides: Partial<CaseloadItem> = {}): CaseloadItem {
  const base: CaseloadItem = {
    participantId: "a015g00000ABCDxQAO",
    displayName: "Casey",
    peLabel: null,
    programCode: null,
    aftercareDay: 100,
    aftercareStartDate: null,
    tier: 2,
    tierLabel: "Act this week",
    priorityScore: 42.5,
    priorityModifier: null,
    highestImpactFactor: null,
    factors: [],
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

function tag(severity: RowTag["severity"], key: string = severity): RowTag {
  return { key, label: key, severity };
}

const ids = (items: ReadonlyArray<CaseloadItem>): string[] =>
  items.map((i) => i.participantId);

describe("applySort — default state preserves server order", () => {
  it("returns the input array BY IDENTITY when state is default", () => {
    const items = [makeItem({ participantId: "p1" }), makeItem({ participantId: "p2" })];
    expect(applySort(items, DEFAULT_SORT)).toBe(items);
  });

  it("returns the input by identity when only direction is null", () => {
    const items = [makeItem()];
    const partial: SortState = { column: "tier", direction: null };
    expect(applySort(items, partial)).toBe(items);
  });

  it("does not mutate the input array", () => {
    const items = [
      makeItem({ participantId: "p1", tier: 3 }),
      makeItem({ participantId: "p2", tier: 1 }),
    ];
    const before = ids(items);
    applySort(items, { column: "tier", direction: "asc" });
    expect(ids(items)).toEqual(before);
  });
});

describe("applySort — tier (numeric)", () => {
  const items = [
    makeItem({ participantId: "p3", tier: 3 }),
    makeItem({ participantId: "p1", tier: 1 }),
    makeItem({ participantId: "p2", tier: 2 }),
  ];

  it("ascending orders 1,2,3 numerically (not lexicographically)", () => {
    expect(ids(applySort(items, { column: "tier", direction: "asc" }))).toEqual([
      "p1",
      "p2",
      "p3",
    ]);
  });

  it("descending orders 3,2,1", () => {
    expect(ids(applySort(items, { column: "tier", direction: "desc" }))).toEqual([
      "p3",
      "p2",
      "p1",
    ]);
  });
});

describe("applySort — participant (locale, case-insensitive)", () => {
  it("orders case-insensitively (ana < Bob < cleo)", () => {
    const items = [
      makeItem({ participantId: "c", displayName: "cleo" }),
      makeItem({ participantId: "b", displayName: "Bob" }),
      makeItem({ participantId: "a", displayName: "ana" }),
    ];
    expect(
      ids(applySort(items, { column: "participant", direction: "asc" })),
    ).toEqual(["a", "b", "c"]);
  });
});

describe("applySort — lastContact (numeric days ago)", () => {
  const items = [
    makeItem({ participantId: "old", lastSuccessfulContactDaysAgo: 30 }),
    makeItem({ participantId: "recent", lastSuccessfulContactDaysAgo: 2 }),
    makeItem({ participantId: "mid", lastSuccessfulContactDaysAgo: 12 }),
  ];

  it("ascending = most recent first (fewest days ago)", () => {
    expect(
      ids(applySort(items, { column: "lastContact", direction: "asc" })),
    ).toEqual(["recent", "mid", "old"]);
  });

  it("descending = most stale first (most days ago)", () => {
    expect(
      ids(applySort(items, { column: "lastContact", direction: "desc" })),
    ).toEqual(["old", "mid", "recent"]);
  });
});

describe("applySort — stability (composite cycle key)", () => {
  it("descending surfaces the most-overdue row first, most-stable last", () => {
    const items = [
      makeItem({
        participantId: "stable",
        cycleStatus: {
          state: "between",
          daysToNext: null,
          daysOverdue: 0,
          nextCheckpoint: null,
          lastCreditedCheckpoint: null,
        },
      }),
      makeItem({
        participantId: "overdue",
        cycleStatus: {
          state: "overdue",
          daysToNext: null,
          daysOverdue: 14,
          nextCheckpoint: null,
          lastCreditedCheckpoint: null,
        },
      }),
      makeItem({
        participantId: "soon",
        cycleStatus: {
          state: "due",
          daysToNext: 3,
          daysOverdue: 0,
          nextCheckpoint: null,
          lastCreditedCheckpoint: null,
        },
      }),
    ];
    // overdue (14) > soon (due in 3 → rank -3) > stable (no next → -Infinity)
    expect(
      ids(applySort(items, { column: "stability", direction: "desc" })),
    ).toEqual(["overdue", "soon", "stable"]);
  });
});

describe("applySort — severity (reuses severitySummary rollup)", () => {
  it("a high tag ranks as critical; descending surfaces it first", () => {
    const items = [
      makeItem({ participantId: "monitor", tags: [tag("low")] }),
      makeItem({ participantId: "critical", tags: [tag("high")] }),
      makeItem({ participantId: "attention", tags: [tag("med")] }),
    ];
    expect(
      ids(applySort(items, { column: "severity", direction: "desc" })),
    ).toEqual(["critical", "attention", "monitor"]);
  });

  it("within the same level, descending puts the busiest row first", () => {
    const items = [
      makeItem({ participantId: "one", tags: [tag("high")] }),
      makeItem({ participantId: "three", tags: [tag("high"), tag("high", "h2"), tag("low")] }),
    ];
    expect(
      ids(applySort(items, { column: "severity", direction: "desc" })),
    ).toEqual(["three", "one"]);
  });
});

describe("applySort — nulls always last (both directions)", () => {
  it("null tier sinks to the bottom ascending AND descending", () => {
    const items = [
      makeItem({ participantId: "none", tier: null }),
      makeItem({ participantId: "t1", tier: 1 }),
      makeItem({ participantId: "t2", tier: 2 }),
    ];
    expect(
      ids(applySort(items, { column: "tier", direction: "asc" })),
    ).toEqual(["t1", "t2", "none"]);
    expect(
      ids(applySort(items, { column: "tier", direction: "desc" })),
    ).toEqual(["t2", "t1", "none"]);
  });

  it("never-contacted (null) sinks last even sorting most-stale-first", () => {
    const items = [
      makeItem({ participantId: "never", lastSuccessfulContactDaysAgo: null }),
      makeItem({ participantId: "stale", lastSuccessfulContactDaysAgo: 40 }),
      makeItem({ participantId: "fresh", lastSuccessfulContactDaysAgo: 1 }),
    ];
    expect(
      ids(applySort(items, { column: "lastContact", direction: "desc" })),
    ).toEqual(["stale", "fresh", "never"]);
  });

  it("empty/whitespace participant name is treated as missing", () => {
    const items = [
      makeItem({ participantId: "blank", displayName: "" }),
      makeItem({ participantId: "named", displayName: "Zed" }),
    ];
    expect(
      ids(applySort(items, { column: "participant", direction: "asc" })),
    ).toEqual(["named", "blank"]);
  });
});

describe("applySort — stable tie-breaks", () => {
  it("equal keys preserve original (server) order", () => {
    const items = [
      makeItem({ participantId: "first", tier: 2 }),
      makeItem({ participantId: "second", tier: 2 }),
      makeItem({ participantId: "third", tier: 2 }),
    ];
    expect(
      ids(applySort(items, { column: "tier", direction: "asc" })),
    ).toEqual(["first", "second", "third"]);
  });

  it("all-missing input preserves original order", () => {
    const items = [
      makeItem({ participantId: "a", tier: null }),
      makeItem({ participantId: "b", tier: null }),
    ];
    expect(
      ids(applySort(items, { column: "tier", direction: "desc" })),
    ).toEqual(["a", "b"]);
  });
});

describe("sortReducer — tri-state cycle", () => {
  it("clicking a new column jumps to that column ascending", () => {
    expect(sortReducer(DEFAULT_SORT, { type: "click", column: "tier" })).toEqual({
      column: "tier",
      direction: "asc",
    });
  });

  it("same column cycles asc → desc → default → asc", () => {
    const asc: SortState = { column: "tier", direction: "asc" };
    const desc = sortReducer(asc, { type: "click", column: "tier" });
    expect(desc).toEqual({ column: "tier", direction: "desc" });
    const back = sortReducer(desc, { type: "click", column: "tier" });
    expect(back).toEqual(DEFAULT_SORT);
    const again = sortReducer(back, { type: "click", column: "tier" });
    expect(again).toEqual({ column: "tier", direction: "asc" });
  });

  it("switching to a different column resets to that column ascending", () => {
    const desc: SortState = { column: "tier", direction: "desc" };
    expect(
      sortReducer(desc, { type: "click", column: "participant" }),
    ).toEqual({ column: "participant", direction: "asc" });
  });
});

describe("describeSort — live-region sentence", () => {
  it("reports the default order", () => {
    expect(describeSort(DEFAULT_SORT)).toBe("Default order");
  });

  it("reports column + direction with the visible label", () => {
    expect(describeSort({ column: "lastContact", direction: "desc" })).toBe(
      "Sorted by Last contact descending",
    );
    expect(describeSort({ column: "participant", direction: "asc" })).toBe(
      "Sorted by Participant ascending",
    );
  });
});
