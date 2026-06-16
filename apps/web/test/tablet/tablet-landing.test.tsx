// @vitest-environment happy-dom

// P3C-13 / P3B-06 — tablet "Today" home, now LIVE. The hero renders the
// top-priority `CaseloadItem`; the Pending Sync panel is Outbox-sourced (queued
// / syncing / just-synced writes); the header badge reflects the Outbox count.
// The Outbox hook is mocked here so this stays a focused render test — the
// offline mechanics have their own unit suites (use-outbox / replay /
// with-outbox-mirror) and the Quick Log sheet has its own suite
// (quick-log-sheet.test.tsx).

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CaseloadItem } from "@anthos/api";

import type { OutboxItem } from "../../app/_lib/offline/use-outbox";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Mutable hook returns, set per-test before render.
let outboxReturn: { items: ReadonlyArray<OutboxItem>; count: number } = {
  items: [],
  count: 0,
};

vi.mock("../../app/_lib/offline/use-outbox", () => ({
  useOutbox: () => outboxReturn,
}));

// Imported AFTER the mocks are registered.
const { TabletLanding } = await import("../../app/_components/tablet/TabletLanding");

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  outboxReturn = { items: [], count: 0 };
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

function makeCaseloadItem(overrides: Partial<CaseloadItem>): CaseloadItem {
  return {
    participantId: "p-test",
    displayName: "Test Participant",
    peLabel: null,
    programCode: null,
    aftercareDay: null,
    aftercareStartDate: null,
    tier: 1,
    tierLabel: "Tier 1",
    priorityScore: 90,
    priorityModifier: null,
    highestImpactFactor: null,
    factors: [],
    secondaryFactorLabel: null,
    triggered_invariants: [],
    lastSuccessfulContactDaysAgo: null,
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
      state: "complete",
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
    ...overrides,
  };
}

function makeOutboxItem(overrides: Partial<OutboxItem>): OutboxItem {
  return {
    id: "key-1",
    endpoint: "/api/v1/participants/p-real-1/calls",
    method: "POST",
    body: { status: "Completed" },
    idempotencyKey: "key-1",
    enqueuedAt: 1,
    retryCount: 0,
    state: "pending_sync",
    uiStatus: "pending_sync",
    ...overrides,
  };
}

function render(node: React.ReactElement): void {
  act(() => {
    root.render(node);
  });
}

describe("TabletLanding (live)", () => {
  it("shows the header pending badge from the Outbox count", () => {
    outboxReturn = { items: [], count: 2 };
    render(
      <TabletLanding
        initialCaseloadItems={[]}
        caseloadCount={0}
        specialistName={null}
        specialistId={null}
      />,
    );
    const badge = container.querySelector('[data-testid="tablet-header-pending-badge"]');
    expect(badge?.textContent).toContain("2 pending");
  });

  it("hides the badge when the Outbox is empty", () => {
    render(
      <TabletLanding
        initialCaseloadItems={[]}
        caseloadCount={0}
        specialistName={null}
        specialistId={null}
      />,
    );
    expect(container.querySelector('[data-testid="tablet-header-pending-badge"]')).toBeNull();
  });

  it("labels the header with the specialist name when provided", () => {
    render(
      <TabletLanding
        initialCaseloadItems={[]}
        caseloadCount={0}
        specialistName="Marie Alcis"
        specialistId="005xx"
      />,
    );
    const label = container.querySelector('[data-testid="tablet-header-specialist"]');
    expect(label?.textContent).toContain("Marie Alcis");
  });

  it("renders the top-priority hero from the first caseload item", () => {
    const real = makeCaseloadItem({
      participantId: "p-real-1",
      displayName: "Real Specialist",
    });
    render(
      <TabletLanding
        initialCaseloadItems={[real]}
        caseloadCount={42}
        specialistName={null}
        specialistId="005xx"
      />,
    );
    expect(container.querySelector('[data-testid="top-priority-participant"]')?.textContent).toBe(
      "Real Specialist",
    );
  });

  it("labels the hero CTA 'Log notes' and opens the Quick Log sheet with the participant name", () => {
    const real = makeCaseloadItem({
      participantId: "a015g00000ABCDxQAO",
      displayName: "Doris Simmons",
    });
    render(
      <TabletLanding
        initialCaseloadItems={[real]}
        caseloadCount={1}
        specialistName={null}
        specialistId="005xx"
        canLogCaseNotes
      />,
    );
    const cta = container.querySelector(
      '[data-testid="top-priority-cta"]',
    ) as HTMLButtonElement | null;
    expect(cta?.textContent).toBe("Log notes");
    expect(cta?.disabled).toBe(false);

    act(() => {
      cta!.click();
    });
    // The Quick Log sheet mounted (route-neutral heading + two-route toggle) and
    // is titled with the participant NAME, never the raw SF id.
    expect(container.textContent).toContain("Log Note");
    expect(container.textContent).toContain("Case Note");
    expect(container.textContent).toContain("Repair");
    expect(container.textContent).toContain("Participant Doris Simmons");
    expect(container.textContent).not.toContain("a015g00000ABCDxQAO");
  });

  it("disables (does not hide) the hero CTA when the role cannot log case notes (BR-67)", () => {
    const real = makeCaseloadItem({
      participantId: "p-real-1",
      displayName: "Real Specialist",
    });
    render(
      <TabletLanding
        initialCaseloadItems={[real]}
        caseloadCount={1}
        specialistName={null}
        specialistId="005xx"
        canLogCaseNotes={false}
      />,
    );
    const cta = container.querySelector(
      '[data-testid="top-priority-cta"]',
    ) as HTMLButtonElement | null;
    expect(cta).not.toBeNull();
    expect(cta?.disabled).toBe(true);
    // Disabled CTA never mounts the sheet.
    expect(container.textContent).not.toContain("Log Note");
  });

  it("no longer surfaces 'Log call' on the tablet landing", () => {
    render(
      <TabletLanding
        initialCaseloadItems={[
          makeCaseloadItem({ participantId: "p-real-1", displayName: "Real Specialist" }),
        ]}
        caseloadCount={1}
        specialistName={null}
        specialistId="005xx"
        canLogCaseNotes
      />,
    );
    expect(container.textContent).not.toContain("Log call");
  });

  it("renders the 'all caught up' hero when the caseload is empty", () => {
    render(
      <TabletLanding
        initialCaseloadItems={[]}
        caseloadCount={0}
        specialistName={null}
        specialistId={null}
      />,
    );
    const hero = container.querySelector('[data-testid="top-priority-card"]');
    expect(hero?.getAttribute("data-empty")).toBe("true");
    expect(hero?.textContent).toContain("All caught up");
  });

  it("renders a syncing row from the Outbox with the participant name", () => {
    outboxReturn = {
      items: [makeOutboxItem({ uiStatus: "syncing" })],
      count: 1,
    };
    render(
      <TabletLanding
        initialCaseloadItems={[
          makeCaseloadItem({ participantId: "p-real-1", displayName: "Real Specialist" }),
        ]}
        caseloadCount={1}
        specialistName={null}
        specialistId="005xx"
      />,
    );
    const row = container.querySelector('[data-testid="pending-queue-syncing-item"]');
    expect(row).not.toBeNull();
    expect(row?.getAttribute("data-ui-status")).toBe("syncing");
    expect(row?.textContent).toContain("Real Specialist");
  });

  it("does not render the server Review Required panel", () => {
    // P3B-06 — the purple server `offline_queue` rows were removed from the
    // tablet landing; only the Outbox-sourced syncing rows remain.
    render(
      <TabletLanding
        initialCaseloadItems={[]}
        caseloadCount={0}
        specialistName={null}
        specialistId="005xx"
      />,
    );
    expect(container.querySelector('[data-testid="review-required-item"]')).toBeNull();
  });

  it("labels a queued Repair syncing row with the participant name", () => {
    outboxReturn = {
      items: [
        makeOutboxItem({
          id: "rkey-1",
          endpoint: "/api/v1/participants/p-real-1/repairs",
          body: { note: "leaky faucet" },
          uiStatus: "pending_sync",
        }),
      ],
      count: 1,
    };
    render(
      <TabletLanding
        initialCaseloadItems={[
          makeCaseloadItem({ participantId: "p-real-1", displayName: "Real Specialist" }),
        ]}
        caseloadCount={1}
        specialistName={null}
        specialistId="005xx"
      />,
    );
    const row = container.querySelector('[data-testid="pending-queue-syncing-item"]');
    expect(row?.textContent).toContain("Repair · Real Specialist");
  });

  it("opens the Quick Log sheet from the caseload 📝 action when the role allows it", () => {
    const real = makeCaseloadItem({
      participantId: "p-real-1",
      displayName: "Real Specialist",
    });
    render(
      <TabletLanding
        initialCaseloadItems={[real]}
        caseloadCount={1}
        specialistName={null}
        specialistId="005xx"
        canLogCaseNotes
      />,
    );
    const btn = container.querySelector(
      '[data-testid="collapsed-caseload-log-case-note"]',
    ) as HTMLButtonElement | null;
    expect(btn).not.toBeNull();
    act(() => {
      btn!.click();
    });
    // The Quick Log sheet mounted: route-neutral heading + the two-route
    // toggle, and NOT the desktop-only Contact type picklist.
    expect(container.textContent).toContain("Log Note");
    expect(container.textContent).toContain("Case Note");
    expect(container.textContent).toContain("Repair");
    expect(container.textContent).not.toContain("Contact type");
  });

  it("hides the 📝 caseload action when the role cannot log case notes", () => {
    const real = makeCaseloadItem({
      participantId: "p-real-1",
      displayName: "Real Specialist",
    });
    render(
      <TabletLanding
        initialCaseloadItems={[real]}
        caseloadCount={1}
        specialistName={null}
        specialistId="005xx"
        canLogCaseNotes={false}
      />,
    );
    expect(container.querySelector('[data-testid="collapsed-caseload-log-case-note"]')).toBeNull();
  });

  it("falls back to the demo caseload list when no real items", () => {
    render(
      <TabletLanding
        initialCaseloadItems={[]}
        caseloadCount={0}
        specialistName={null}
        specialistId={null}
      />,
    );
    const caseload = container.querySelector('[data-testid="collapsed-caseload"]');
    expect(caseload?.getAttribute("data-using-real-data")).toBe("false");
  });
});
