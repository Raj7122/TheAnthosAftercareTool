import type { CaseloadCycleStatus } from "@anthos/api";
import { describe, expect, it } from "vitest";

import { cycleBadgeDisplay } from "../../app/_components/participant/cycle-badge-label";

function status(overrides: Partial<CaseloadCycleStatus>): CaseloadCycleStatus {
  return {
    state: "not_in_cycle",
    daysToNext: null,
    daysOverdue: 0,
    nextCheckpoint: null,
    lastCreditedCheckpoint: null,
    ...overrides,
  };
}

describe("cycleBadgeDisplay — BR-33 five-state mapping", () => {
  it("renders 'Not in cycle' as muted when aftercareStartDate is null", () => {
    expect(cycleBadgeDisplay(status({ state: "not_in_cycle" }))).toEqual({
      label: "Not in cycle",
      variant: "muted",
    });
  });

  it("renders 'Pre-enrollment' as muted when start date is future-dated", () => {
    expect(cycleBadgeDisplay(status({ state: "pre_enrollment" }))).toEqual({
      label: "Pre-enrollment",
      variant: "muted",
    });
  });

  it("renders 'Due in N days' with the orange cycleDue variant", () => {
    expect(
      cycleBadgeDisplay(
        status({ state: "due", daysToNext: 7, nextCheckpoint: 90 }),
      ),
    ).toEqual({ label: "Due in 7 days", variant: "cycleDue" });
  });

  it("renders 'OVERDUE N days' with the red cycleOverdue variant", () => {
    expect(
      cycleBadgeDisplay(status({ state: "overdue", daysOverdue: 12 })),
    ).toEqual({ label: "OVERDUE 12 days", variant: "cycleOverdue" });
  });

  it("renders catch_up with the purple cycleCatchUp variant", () => {
    expect(
      cycleBadgeDisplay(status({ state: "catch_up", daysOverdue: 95 })),
    ).toEqual({ label: "OVERDUE 95 days", variant: "cycleCatchUp" });
  });

  it("renders 'Done' as green when the cycle is complete at this anchor", () => {
    expect(
      cycleBadgeDisplay(
        status({ state: "complete", lastCreditedCheckpoint: 365 }),
      ),
    ).toEqual({ label: "Done", variant: "cycleComplete" });
  });

  it("renders 'On track' as green for the 'between' aggregate state", () => {
    expect(
      cycleBadgeDisplay(
        status({ state: "between", daysToNext: 45, nextCheckpoint: 180 }),
      ),
    ).toEqual({ label: "On track", variant: "cycleComplete" });
  });

  it("renders 'Cycle complete' as muted past day 365", () => {
    expect(cycleBadgeDisplay(status({ state: "cycle_complete" }))).toEqual({
      label: "Cycle complete",
      variant: "muted",
    });
  });

  it("falls back to a neutral 'Future' label if the per-anchor state ever leaks through", () => {
    expect(cycleBadgeDisplay(status({ state: "future" }))).toEqual({
      label: "Future",
      variant: "muted",
    });
  });

  it("falls back to 'Due soon' when state=due and daysToNext is null", () => {
    expect(
      cycleBadgeDisplay(status({ state: "due", daysToNext: null })),
    ).toEqual({ label: "Due soon", variant: "cycleDue" });
  });
});
