import { describe, expect, it } from "vitest";

import type {
  CaseloadOpenBarrier,
  CaseloadStabilityVisit,
  ParticipantRecentContact,
} from "@anthos/api";

import type { OptimisticSend } from "../../app/_lib/comms/types";
import {
  buildCalendarEvents,
  groupEventsByDay,
  legendKinds,
  type BuildCalendarEventsInput,
} from "../../app/_lib/calendar/events";

const VISIT: CaseloadStabilityVisit = {
  status: "upcoming",
  statusLabel: "Upcoming",
  nextDueDate: "2026-06-15",
  checkpoint: null,
  completedCount: null,
  missedCount: null,
  scheduledVisitDateTime: null,
};

function contact(
  partial: Partial<ParticipantRecentContact>,
): ParticipantRecentContact {
  return {
    contactId: "c1",
    type: "case_note",
    caseNoteType: null,
    contactType: null,
    channel: null,
    status: null,
    summary: null,
    timestamp: null,
    loggedBy: null,
    sfRecordId: "sf1",
    provenance: "pe_rollup",
    ...partial,
  };
}

function barrier(partial: Partial<CaseloadOpenBarrier>): CaseloadOpenBarrier {
  return {
    barrierId: "b1",
    type: "Housing",
    severity: "high",
    openedAt: "2026-02-10T00:00:00Z",
    ageDays: 10,
    ...partial,
  };
}

function send(partial: Partial<OptimisticSend>): OptimisticSend {
  return {
    id: "s1",
    channel: "sms",
    label: "Outbound SMS",
    summary: "hi",
    status: "Sent",
    timestamp: "2026-05-29T14:00:00Z",
    ...partial,
  };
}

function base(
  partial: Partial<BuildCalendarEventsInput>,
): BuildCalendarEventsInput {
  return {
    aftercareStartDate: null,
    perCheckpointBreakdown: [],
    stabilityVisit: { ...VISIT, nextDueDate: null },
    recentContacts: [],
    openBarriers: [],
    optimisticSends: [],
    ...partial,
  };
}

describe("buildCalendarEvents — checkpoints", () => {
  it("computes the anchor date as start + anchor days (UTC)", () => {
    const events = buildCalendarEvents(
      base({
        aftercareStartDate: "2026-01-01",
        perCheckpointBreakdown: [{ anchor: 90, state: "future" }],
      }),
    );
    const cp = events.find((e) => e.kind === "checkpoint");
    expect(cp?.ymd).toBe("2026-04-01"); // 2026-01-01 + 90d
    expect(cp?.title).toBe("90-day stability visit");
    expect(cp?.state).toBe("future");
  });

  it("skips checkpoints when the start date is missing", () => {
    const events = buildCalendarEvents(
      base({
        aftercareStartDate: null,
        perCheckpointBreakdown: [{ anchor: 90, state: "due" }],
      }),
    );
    expect(events.some((e) => e.kind === "checkpoint")).toBe(false);
  });
});

describe("buildCalendarEvents — due date, contacts, barriers", () => {
  it("plots the next visit-due date", () => {
    const events = buildCalendarEvents(base({ stabilityVisit: VISIT }));
    const due = events.find((e) => e.kind === "visit_due");
    expect(due?.ymd).toBe("2026-06-15");
  });

  it("classifies a logged contact by channel and uses its timestamp day", () => {
    const events = buildCalendarEvents(
      base({
        recentContacts: [
          contact({
            caseNoteType: "Outbound SMS",
            timestamp: "2026-05-29T23:30:00Z",
          }),
        ],
      }),
    );
    const ev = events.find((e) => e.kind === "sms");
    expect(ev?.ymd).toBe("2026-05-29");
  });

  it("maps an open barrier to its opened day", () => {
    const events = buildCalendarEvents(
      base({ openBarriers: [barrier({ type: "Income" })] }),
    );
    const ev = events.find((e) => e.kind === "barrier");
    expect(ev?.ymd).toBe("2026-02-10");
    expect(ev?.title).toBe("Barrier: Income");
  });
});

describe("buildCalendarEvents — optimistic sends", () => {
  it("plots a scheduled visit on its eventDate, not the send instant", () => {
    const events = buildCalendarEvents(
      base({
        optimisticSends: [
          send({
            id: "v1",
            channel: "schedule",
            label: "Stability visit",
            status: "Scheduled",
            timestamp: "2026-05-29T14:00:00Z",
            eventDate: "2026-07-01",
          }),
        ],
      }),
    );
    const ev = events.find((e) => e.id === "v1");
    expect(ev?.kind).toBe("visit");
    expect(ev?.ymd).toBe("2026-07-01");
  });

  it("plots an SMS send on the send day (no eventDate)", () => {
    const events = buildCalendarEvents(
      base({ optimisticSends: [send({ id: "m1", channel: "sms" })] }),
    );
    const ev = events.find((e) => e.id === "m1");
    expect(ev?.kind).toBe("sms");
    expect(ev?.ymd).toBe("2026-05-29");
  });
});

describe("groupEventsByDay / legendKinds", () => {
  it("groups multiple events under one day key", () => {
    const events = buildCalendarEvents(
      base({
        recentContacts: [
          contact({ caseNoteType: "Phone Call", timestamp: "2026-05-29T10:00:00Z" }),
        ],
        optimisticSends: [send({ id: "m1", timestamp: "2026-05-29T14:00:00Z" })],
      }),
    );
    const byDay = groupEventsByDay(events);
    expect(byDay.get("2026-05-29")).toHaveLength(2);
  });

  it("returns present kinds in legend order", () => {
    const events = buildCalendarEvents(
      base({
        aftercareStartDate: "2026-01-01",
        perCheckpointBreakdown: [{ anchor: 90, state: "future" }],
        optimisticSends: [send({ id: "m1", channel: "email" })],
      }),
    );
    expect(legendKinds(events)).toEqual(["checkpoint", "email"]);
  });
});
