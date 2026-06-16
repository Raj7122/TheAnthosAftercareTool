import type { CaseloadItem } from "@anthos/api";
import { describe, expect, it } from "vitest";

import {
  buildCaseloadCalendarEvents,
  type CaseloadCalendarEvent,
} from "../../app/_lib/calendar/caseload-events";
import { groupEventsByDay } from "../../app/_lib/calendar/events";

function makeItem(overrides: Partial<CaseloadItem> = {}): CaseloadItem {
  const base: CaseloadItem = {
    participantId: "p1",
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

describe("buildCaseloadCalendarEvents", () => {
  it("tags every event with its participant id + name", () => {
    const events = buildCaseloadCalendarEvents([
      makeItem({
        participantId: "p1",
        displayName: "Casey Rivera",
        stabilityVisit: {
          status: "upcoming",
          statusLabel: "Upcoming",
          nextDueDate: "2026-06-15",
          checkpoint: null,
          completedCount: null,
          missedCount: null,
          scheduledVisitDateTime: null,
        },
      }),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "visit_due",
      participantId: "p1",
      participantName: "Casey Rivera",
    });
  });

  it("computes checkpoint dates from aftercareStartDate + anchor days (UTC)", () => {
    const events = buildCaseloadCalendarEvents([
      makeItem({
        participantId: "p1",
        aftercareStartDate: "2026-01-01",
        perCheckpointBreakdown: [
          { anchor: 90, state: "complete" },
          { anchor: 180, state: "future" },
        ],
      }),
    ]);
    const byDay = groupEventsByDay(events);
    // 2026-01-01 + 90 days = 2026-04-01; + 180 days = 2026-06-30.
    expect(byDay.get("2026-04-01")?.[0]).toMatchObject({ kind: "checkpoint" });
    expect(byDay.get("2026-06-30")?.[0]).toMatchObject({ kind: "checkpoint" });
  });

  it("omits checkpoints when aftercareStartDate is absent", () => {
    const events = buildCaseloadCalendarEvents([
      makeItem({
        aftercareStartDate: null,
        perCheckpointBreakdown: [{ anchor: 90, state: "future" }],
      }),
    ]);
    expect(events.filter((e) => e.kind === "checkpoint")).toHaveLength(0);
  });

  it("namespaces event ids by participant so two rows never collide", () => {
    const events = buildCaseloadCalendarEvents([
      makeItem({
        participantId: "p1",
        aftercareStartDate: "2026-01-01",
        perCheckpointBreakdown: [{ anchor: 90, state: "future" }],
      }),
      makeItem({
        participantId: "p2",
        aftercareStartDate: "2026-01-01",
        perCheckpointBreakdown: [{ anchor: 90, state: "future" }],
      }),
    ]);
    const ids = events.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("p1:checkpoint-90");
    expect(ids).toContain("p2:checkpoint-90");
  });

  it("plots open barriers on their opened date", () => {
    const events = buildCaseloadCalendarEvents([
      makeItem({
        participantId: "p1",
        openBarriers: [
          {
            barrierId: "b1",
            type: "Housing",
            severity: "high",
            openedAt: "2026-02-10T00:00:00Z",
            ageDays: 10,
          },
        ],
      }),
    ]);
    const barrier = events.find((e) => e.kind === "barrier");
    expect(barrier).toMatchObject({ ymd: "2026-02-10", participantId: "p1" });
  });

  it("carries a null participantName through (warm-cache read)", () => {
    const events = buildCaseloadCalendarEvents([
      makeItem({
        participantId: "p1",
        displayName: null,
        stabilityVisit: {
          status: "upcoming",
          statusLabel: "Upcoming",
          nextDueDate: "2026-06-15",
          checkpoint: null,
          completedCount: null,
          missedCount: null,
          scheduledVisitDateTime: null,
        },
      }),
    ]);
    expect(events[0]?.participantName).toBeNull();
  });

  it("returns an empty list for an empty caseload", () => {
    const events: ReadonlyArray<CaseloadCalendarEvent> =
      buildCaseloadCalendarEvents([]);
    expect(events).toEqual([]);
  });
});
