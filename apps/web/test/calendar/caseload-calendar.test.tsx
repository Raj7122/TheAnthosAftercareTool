// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CaseloadItem } from "@anthos/api";

import { CaseloadCalendar } from "../../app/caseload/_components/CaseloadCalendar";
import type { CaseloadCalendarEvent } from "../../app/_lib/calendar/caseload-events";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

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

const withVisitDue = (id: string, name: string, due: string): CaseloadItem =>
  makeItem({
    participantId: id,
    displayName: name,
    stabilityVisit: {
      status: "upcoming",
      statusLabel: "Upcoming",
      nextDueDate: due,
      checkpoint: null,
      completedCount: null,
      missedCount: null,
      scheduledVisitDateTime: null,
    },
  });

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

describe("CaseloadCalendar", () => {
  it("renders a month grid on laptop", () => {
    act(() => {
      root.render(
        <CaseloadCalendar
          items={[withVisitDue("p1", "Casey Rivera", "2026-06-15")]}
          variant="laptop"
        />,
      );
    });
    expect(container.querySelector('[role="grid"]')).not.toBeNull();
  });

  it("renders the two-column layout with selected-day + this-month cards on laptop", () => {
    act(() => {
      root.render(
        <CaseloadCalendar
          items={[withVisitDue("p1", "Casey Rivera", "2026-06-15")]}
          variant="laptop"
        />,
      );
    });
    // P3D-03 — month grid (left) + selected-day & this-month cards (right).
    expect(container.querySelector('[role="grid"]')).not.toBeNull();
    expect(container.textContent).toContain("Selected day");
    expect(container.textContent).toContain("This month");
    // Stat tiles.
    expect(container.textContent).toContain("Visits");
    expect(container.textContent).toContain("Checkpoints");
    expect(container.textContent).toContain("Barriers");
    // Period-count footer.
    expect(container.textContent).toMatch(/events? this period/);
  });

  it("renders an agenda (no grid) on tablet and deep-links each event", () => {
    act(() => {
      root.render(
        <CaseloadCalendar
          items={[withVisitDue("p1", "Casey Rivera", "2026-06-15")]}
          variant="tablet"
        />,
      );
    });
    // BR-65: no horizontal-scroll grid on tablet portrait.
    expect(container.querySelector('[role="grid"]')).toBeNull();
    const link = container.querySelector('a[href="/participants/p1"]');
    expect(link).not.toBeNull();
    expect(link?.textContent).toContain("Casey Rivera");
    expect(link?.textContent).toContain("Stability visit due");
  });

  it("shows an empty state on tablet when nothing is plottable", () => {
    act(() => {
      root.render(<CaseloadCalendar items={[makeItem()]} variant="tablet" />);
    });
    expect(container.textContent).toContain("No activity on your caseload");
    expect(container.querySelector("a")).toBeNull();
  });

  it("makes no network call itself (the hook fetches; the component renders props)", () => {
    const fetchSpy = vi.fn();
    (globalThis as unknown as { fetch: unknown }).fetch = fetchSpy;
    act(() => {
      root.render(
        <CaseloadCalendar
          items={[withVisitDue("p1", "Casey Rivera", "2026-06-15")]}
          variant="tablet"
        />,
      );
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// --- Phase B: merged activity layer, filters, degradation --------------------

function activityEvent(
  overrides: Partial<CaseloadCalendarEvent> & { id: string },
): CaseloadCalendarEvent {
  return {
    ymd: "2026-06-12",
    kind: "phone",
    title: "Check In",
    participantId: "p1",
    participantName: "Casey Rivera",
    ...overrides,
  };
}

describe("CaseloadCalendar — Phase B activity layer", () => {
  it("merges fetched activity events into the tablet agenda", () => {
    act(() => {
      root.render(
        <CaseloadCalendar
          items={[makeItem({ participantId: "p1" })]}
          variant="tablet"
          activityEvents={[
            activityEvent({ id: "p1:sms-1", kind: "sms", title: "SMS", ymd: "2026-06-12" }),
          ]}
          activityState="ready"
        />,
      );
    });
    const link = container.querySelector('a[href="/participants/p1"]');
    expect(link?.textContent).toContain("SMS");
  });

  it("hides a kind when its legend chip is toggled off", () => {
    act(() => {
      root.render(
        <CaseloadCalendar
          items={[makeItem({ participantId: "p1" })]}
          variant="tablet"
          activityEvents={[
            activityEvent({ id: "p1:sms-1", kind: "sms", title: "SMS" }),
            activityEvent({ id: "p1:cn-1", kind: "phone", title: "Check In" }),
          ]}
          activityState="ready"
        />,
      );
    });
    // Both kinds present initially.
    expect(container.textContent).toContain("SMS");
    expect(container.textContent).toContain("Check In");

    // Toggle the SMS filter chip off.
    const smsChip = [...container.querySelectorAll('button[aria-pressed]')].find(
      (b) => b.textContent?.trim() === "SMS",
    );
    expect(smsChip).toBeTruthy();
    act(() => {
      smsChip!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // SMS row gone; phone row remains.
    const links = [...container.querySelectorAll("a")].map((a) => a.textContent);
    expect(links.some((t) => t?.includes("SMS"))).toBe(false);
    expect(links.some((t) => t?.includes("Check In"))).toBe(true);
  });

  it("shows a loading note while fetching", () => {
    act(() => {
      root.render(
        <CaseloadCalendar items={[makeItem()]} variant="tablet" activityState="loading" />,
      );
    });
    expect(container.textContent).toContain("Loading scheduled visits");
  });

  it("degrades to Phase-A events with a note on fetch error", () => {
    act(() => {
      root.render(
        <CaseloadCalendar
          items={[withVisitDue("p1", "Casey Rivera", "2026-06-15")]}
          variant="tablet"
          activityState="error"
        />,
      );
    });
    // Error note shown...
    expect(container.textContent).toContain("Couldn't load");
    // ...but the Phase-A cache-derived event still renders.
    expect(container.querySelector('a[href="/participants/p1"]')).not.toBeNull();
  });
});
