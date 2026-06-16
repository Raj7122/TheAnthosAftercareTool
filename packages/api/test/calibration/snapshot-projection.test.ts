import { describe, expect, it } from "vitest";

import { getCalibrationConfiguration } from "@anthos/domain";

import { projectSnapshot } from "../../src/calibration/snapshot-projection.js";
import {
  dueDatesWith,
  makeArrear,
  makeBarrier,
  makeIncident,
  makeSnapshot,
} from "./_fixtures.js";

// P0-04f — per-factor projection unit tests. `config` is the real P0-11
// calibration default (dueStatusLeadTimeDays=14, recentIncidentWindowDays=30);
// `NOW` is a fixed scoring clock so every day-math assertion is deterministic.
const NOW = new Date("2026-05-21T12:00:00Z");
const MS_PER_DAY = 86_400_000;
const config = getCalibrationConfiguration();

// A Date `days` whole days from NOW (negative = in the past).
function offsetDays(days: number): Date {
  return new Date(NOW.getTime() + days * MS_PER_DAY);
}

describe("projectSnapshot — BR-19(a) days_since_last_contact", () => {
  it("derives whole days from the most recent successful contact", () => {
    const snap = makeSnapshot("P-1", "005A", {
      enrollment: { mostRecentSuccessfulContact: offsetDays(-10) },
    });
    expect(projectSnapshot(snap, config, NOW).days_since_last_contact).toBe(10);
  });

  it("passes through null (never contacted — BR-15 sentinel path)", () => {
    const snap = makeSnapshot("P-1", "005A");
    expect(
      projectSnapshot(snap, config, NOW).days_since_last_contact,
    ).toBeNull();
  });

  it("yields a negative count for a future-dated contact", () => {
    const snap = makeSnapshot("P-1", "005A", {
      enrollment: { mostRecentSuccessfulContact: offsetDays(3) },
    });
    expect(projectSnapshot(snap, config, NOW).days_since_last_contact).toBe(-3);
  });
});

describe("projectSnapshot — BR-19(b) stability_visit_state", () => {
  it("is 'upcoming' when the next checkpoint is inside the lead window", () => {
    const snap = makeSnapshot("P-1", "005A", {
      enrollment: { dueDates: dueDatesWith(offsetDays(7)) },
    });
    expect(projectSnapshot(snap, config, NOW).stability_visit_state).toBe(
      "upcoming",
    );
  });

  it("is 'upcoming' at the lead-window boundary (inclusive)", () => {
    const snap = makeSnapshot("P-1", "005A", {
      enrollment: {
        dueDates: dueDatesWith(offsetDays(config.dueStatusLeadTimeDays)),
      },
    });
    expect(projectSnapshot(snap, config, NOW).stability_visit_state).toBe(
      "upcoming",
    );
  });

  it("is 'on_track' when the next checkpoint is beyond the lead window", () => {
    const snap = makeSnapshot("P-1", "005A", {
      enrollment: { dueDates: dueDatesWith(offsetDays(40)) },
    });
    expect(projectSnapshot(snap, config, NOW).stability_visit_state).toBe(
      "on_track",
    );
  });

  it("is 'on_track' when there is no upcoming checkpoint", () => {
    const snap = makeSnapshot("P-1", "005A");
    expect(projectSnapshot(snap, config, NOW).stability_visit_state).toBe(
      "on_track",
    );
  });

  it("is 'on_track' for a past-due checkpoint (missed/catchup not derivable)", () => {
    const snap = makeSnapshot("P-1", "005A", {
      enrollment: { dueDates: dueDatesWith(offsetDays(-5)) },
    });
    expect(projectSnapshot(snap, config, NOW).stability_visit_state).toBe(
      "on_track",
    );
  });
});

describe("projectSnapshot — BR-19(c) failed_attempts", () => {
  it("passes through the attempted-check-in rollup", () => {
    const snap = makeSnapshot("P-1", "005A", {
      enrollment: { checkInsAttempted: 5 },
    });
    expect(projectSnapshot(snap, config, NOW).failed_attempts).toBe(5);
  });

  it("coerces a null rollup to 0 (the factor throws on a non-number)", () => {
    const snap = makeSnapshot("P-1", "005A");
    expect(projectSnapshot(snap, config, NOW).failed_attempts).toBe(0);
  });
});

describe("projectSnapshot — BR-19(d) recent_incident", () => {
  it("is true when an incident falls inside the recent window", () => {
    const snap = makeSnapshot("P-1", "005A", {
      incidents: [makeIncident({ incidentDate: offsetDays(-5) })],
    });
    expect(projectSnapshot(snap, config, NOW).recent_incident).toBe(true);
  });

  it("is true at the window boundary (inclusive)", () => {
    const snap = makeSnapshot("P-1", "005A", {
      incidents: [
        makeIncident({
          incidentDate: offsetDays(-config.recentIncidentWindowDays),
        }),
      ],
    });
    expect(projectSnapshot(snap, config, NOW).recent_incident).toBe(true);
  });

  it("is false for an incident older than the window", () => {
    const snap = makeSnapshot("P-1", "005A", {
      incidents: [makeIncident({ incidentDate: offsetDays(-45) })],
    });
    expect(projectSnapshot(snap, config, NOW).recent_incident).toBe(false);
  });

  it("is false for an empty collection and for a dateless incident", () => {
    expect(
      projectSnapshot(makeSnapshot("P-1", "005A"), config, NOW).recent_incident,
    ).toBe(false);
    const snap = makeSnapshot("P-1", "005A", {
      incidents: [makeIncident({ incidentDate: null })],
    });
    expect(projectSnapshot(snap, config, NOW).recent_incident).toBe(false);
  });
});

describe("projectSnapshot — BR-19(e) open_barriers", () => {
  it("includes open barriers identified at the Aftercare stage", () => {
    const snap = makeSnapshot("P-1", "005A", {
      barriers: [
        makeBarrier({
          id: "a0Bxx0000001ABC",
          type: "Cannot reach participant",
          stage: "Aftercare",
          endDate: null,
          daysSinceLastUpdate: 12,
        }),
      ],
    });
    expect(projectSnapshot(snap, config, NOW).open_barriers).toEqual([
      {
        id: "a0Bxx0000001ABC",
        type: "Cannot reach participant",
        daysSinceLastUpdate: 12,
      },
    ]);
  });

  it("excludes closed barriers (endDate set)", () => {
    const snap = makeSnapshot("P-1", "005A", {
      barriers: [
        makeBarrier({ type: "X", stage: "Aftercare", endDate: offsetDays(-1) }),
      ],
    });
    expect(projectSnapshot(snap, config, NOW).open_barriers).toEqual([]);
  });

  it("excludes barriers identified at a non-Aftercare stage", () => {
    const snap = makeSnapshot("P-1", "005A", {
      barriers: [
        makeBarrier({ type: "X", stage: "Move In", endDate: null }),
      ],
    });
    expect(projectSnapshot(snap, config, NOW).open_barriers).toEqual([]);
  });

  it("passes daysSinceLastUpdate through (BR-39)", () => {
    const snap = makeSnapshot("P-1", "005A", {
      barriers: [
        makeBarrier({
          id: "a0Bxx0000004JKL",
          type: "X",
          stage: "Aftercare",
          endDate: null,
          daysSinceLastUpdate: 45,
        }),
        makeBarrier({
          id: "a0Bxx0000005MNO",
          type: "Y",
          stage: "Aftercare",
          endDate: null,
          daysSinceLastUpdate: null,
        }),
      ],
    });
    expect(projectSnapshot(snap, config, NOW).open_barriers).toEqual([
      { id: "a0Bxx0000004JKL", type: "X", daysSinceLastUpdate: 45 },
      { id: "a0Bxx0000005MNO", type: "Y", daysSinceLastUpdate: null },
    ]);
  });
});

describe("projectSnapshot — BR-19(g) arrears", () => {
  it("passes the arrears collection through by reference", () => {
    const snap = makeSnapshot("P-1", "005A", {
      arrears: [makeArrear({ status: "Identified" })],
    });
    expect(projectSnapshot(snap, config, NOW).arrears).toBe(snap.arrears);
  });
});

describe("projectSnapshot — BR-19(h) aftercare_extended", () => {
  it("passes the aftercare-extended flag through", () => {
    const extended = makeSnapshot("P-1", "005A", {
      enrollment: { aftercareExtended: true },
    });
    expect(projectSnapshot(extended, config, NOW).aftercare_extended).toBe(
      true,
    );
    const notExtended = makeSnapshot("P-2", "005A", {
      enrollment: { aftercareExtended: false },
    });
    expect(projectSnapshot(notExtended, config, NOW).aftercare_extended).toBe(
      false,
    );
  });
});

describe("projectSnapshot — BR-19(i) voucher_recert_deadline", () => {
  it("derives whole days until the recertification deadline", () => {
    const snap = makeSnapshot("P-1", "005A", {
      enrollment: { voucherRecertDeadline: offsetDays(20) },
    });
    expect(projectSnapshot(snap, config, NOW).voucher_recert_deadline).toBe(20);
  });

  it("passes through null when there is no deadline", () => {
    expect(
      projectSnapshot(makeSnapshot("P-1", "005A"), config, NOW)
        .voucher_recert_deadline,
    ).toBeNull();
  });

  it("yields a negative count for a past-due deadline", () => {
    const snap = makeSnapshot("P-1", "005A", {
      enrollment: { voucherRecertDeadline: offsetDays(-3) },
    });
    expect(projectSnapshot(snap, config, NOW).voucher_recert_deadline).toBe(-3);
  });
});

describe("projectSnapshot — structure", () => {
  it("carries identity fields and the raw snapshot", () => {
    const snap = makeSnapshot("P-1", "005A");
    const participant = projectSnapshot(snap, config, NOW);
    expect(participant.participantId).toBe("P-1");
    expect(participant.hydratedAt).toBe(snap.hydratedAt);
    // Kept so BR-25's createOpenRepairInvariant can still read repairs.
    expect(participant.snapshot).toBe(snap);
  });

  it("does not project unit_engagement (retired) or sbop (config-only)", () => {
    const participant = projectSnapshot(makeSnapshot("P-1", "005A"), config, NOW);
    expect(participant).not.toHaveProperty("unit_engagement");
    expect(participant).not.toHaveProperty("sbop");
  });

  it("does not mutate the input snapshot", () => {
    const snap = makeSnapshot("P-1", "005A", {
      enrollment: {
        mostRecentSuccessfulContact: offsetDays(-10),
        checkInsAttempted: 4,
      },
      barriers: [makeBarrier({ stage: "Aftercare" })],
      incidents: [makeIncident({ incidentDate: offsetDays(-1) })],
      arrears: [makeArrear({ status: "Identified" })],
    });
    const before = structuredClone(snap);
    projectSnapshot(snap, config, NOW);
    expect(snap).toEqual(before);
  });
});
