// Sortable caseload headers — ARIA + no-layout-shift coverage at the unit
// level (mirrors `cycle-dots-aria.test.tsx`). Vitest `environment: "node"` is
// fine: `renderToStaticMarkup` gives us the default-state markup to assert
// against — the sticky/sort interaction itself is covered by the e2e.

import type { CaseloadItem } from "@anthos/api";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CaseloadList } from "../../app/caseload/_components/CaseloadList";

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

function render() {
  return renderToStaticMarkup(
    <CaseloadList
      items={[makeItem()]}
      queueId="all"
      canMutateBarriers={false}
      canMutateRepairs={false}
      canLogCaseNotes={false}
      canLogCalls={false}
      pendingParticipantIds={new Set()}
      changedParticipantIds={new Set()}
      onAddRepair={() => {}}
      onLogCaseNote={() => {}}
      onLogCall={() => {}}
      onCloseBarrier={() => {}}
    />,
  );
}

describe("CaseloadList — sortable header ARIA", () => {
  it('marks exactly the five sortable headers with aria-sort="none" by default', () => {
    const html = render();
    // Five sortable columns; the two non-sortable headers ("Why this
    // priority", "Quick actions") carry no aria-sort.
    const ariaSortCount = (html.match(/aria-sort="none"/g) ?? []).length;
    expect(ariaSortCount).toBe(5);
  });

  it("renders each sortable header label as a native button", () => {
    const html = render();
    for (const column of [
      "tier",
      "participant",
      "lastContact",
      "stability",
      "severity",
    ]) {
      expect(html).toContain(`data-testid="caseload-sort-${column}"`);
    }
    // No sort buttons minted for the non-sortable columns.
    expect(html).not.toContain('data-testid="caseload-sort-why"');
    expect(html).not.toContain('data-testid="caseload-sort-actions"');
  });

  it("hides the chevron from screen readers (aria-sort is the SR source)", () => {
    const html = render();
    // The default state renders the always-present ChevronsUpDown glyph in a
    // fixed-size, aria-hidden slot — so no layout shift on sort + no double
    // announcement.
    expect(html).toContain('aria-hidden="true"');
  });

  it("exposes a polite live region for sort announcements", () => {
    const html = render();
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    // Default state sentence.
    expect(html).toContain("Default order");
  });
});
