import type { CaseloadItem } from "@anthos/api";
import { describe, expect, it } from "vitest";

import {
  filterCaseloadItems,
  isBlankQuery,
} from "../../app/caseload/_lib/caseload-search";

function makeItem(overrides: Partial<CaseloadItem> = {}): CaseloadItem {
  const base: CaseloadItem = {
    participantId: "a015g00000ABCDxQAO",
    displayName: "Casey Rivera",
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

const ids = (items: ReadonlyArray<CaseloadItem>): string[] =>
  items.map((i) => i.participantId);

describe("isBlankQuery", () => {
  it("treats empty and whitespace-only queries as blank", () => {
    expect(isBlankQuery("")).toBe(true);
    expect(isBlankQuery("   ")).toBe(true);
    expect(isBlankQuery("\t\n")).toBe(true);
  });

  it("treats any non-whitespace query as non-blank", () => {
    expect(isBlankQuery("a")).toBe(false);
    expect(isBlankQuery("  riv  ")).toBe(false);
  });
});

describe("filterCaseloadItems", () => {
  const casey = makeItem({ participantId: "1", displayName: "Casey Rivera" });
  const marie = makeItem({ participantId: "2", displayName: "Marie Alcis" });
  const acs = makeItem({
    participantId: "3",
    displayName: "Jordan Lee",
    programCode: "ACS;HHN",
  });

  it("returns the input by identity for a blank query (no filter, no copy)", () => {
    const items = [casey, marie];
    expect(filterCaseloadItems(items, "")).toBe(items);
    expect(filterCaseloadItems(items, "   ")).toBe(items);
  });

  it("matches the participant name case-insensitively as a substring", () => {
    expect(ids(filterCaseloadItems([casey, marie], "riv"))).toEqual(["1"]);
    expect(ids(filterCaseloadItems([casey, marie], "MARIE"))).toEqual(["2"]);
    expect(ids(filterCaseloadItems([casey, marie], " casey "))).toEqual(["1"]);
  });

  it("matches the program code as a secondary field", () => {
    expect(ids(filterCaseloadItems([casey, acs], "hhn"))).toEqual(["3"]);
  });

  it("returns an empty array when nothing matches", () => {
    expect(filterCaseloadItems([casey, marie], "zzzzz")).toEqual([]);
  });

  it("is null-safe on a missing displayName", () => {
    const noName = makeItem({ participantId: "9", displayName: null });
    expect(() => filterCaseloadItems([noName], "casey")).not.toThrow();
    expect(filterCaseloadItems([noName], "casey")).toEqual([]);
  });
});
