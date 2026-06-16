import { getCalibrationConfiguration, type Configuration } from "@anthos/domain";
import { describe, expect, it } from "vitest";

import {
  buildCaseloadBody,
  buildCaseloadItem,
  buildPerCheckpointBreakdown,
  stripPiiForCache,
  type CaseloadBody,
} from "../../src/caseload/dto.js";
import {
  dueDatesWith,
  makeArrear,
  makeBarrier,
  makeEngineOutput,
  makeIncident,
  makeScored,
  makeSnapshot,
} from "./_fixtures.js";

const NOW = new Date("2026-05-15T12:00:00Z");
const CONFIG = getCalibrationConfiguration();

// A config variant with a seeded barrier-severity map (the Demo seed is `{}`).
const CONFIG_WITH_SEVERITY: Configuration = {
  ...CONFIG,
  barrierSeverityClassification: { "Cannot reach participant": "high" },
};

// ── engine-core fields ──────────────────────────────────────────────────────

describe("buildCaseloadItem — engine core", () => {
  it("carries tier / score / modifier from the engine output", () => {
    const engine = makeEngineOutput("p1", {
      priorityScore: 88.5,
      tier: 1,
      tierLabel: "Act today",
      priorityModifier: "Aftercare Extended (×1.2)",
    });
    const item = buildCaseloadItem(
      makeScored(makeSnapshot("p1", "owner-1"), engine),
      CONFIG,
      NOW,
    );
    expect(item.tier).toBe(1);
    expect(item.tierLabel).toBe("Act today");
    expect(item.priorityScore).toBe(88.5);
    expect(item.priorityModifier).toBe("Aftercare Extended (×1.2)");
  });

  // P1H-13b: `key` is now exposed on the wire (the SPA needs it to render the
  // value-bearing firing-factor sentence). `weightRaw` is still internal.
  it("exposes `key` on factor breakdown rows but strips `weightRaw`", () => {
    const engine = makeEngineOutput("p1", {
      factors: [
        {
          name: "Days since last successful contact",
          key: "days_since_last_contact",
          valueLabel: "16 days",
          valueNumeric: 16,
          weight: "×1.5",
          weightRaw: 1.5,
          pointsContributed: 24,
        },
      ],
    });
    const item = buildCaseloadItem(
      makeScored(makeSnapshot("p1", "owner-1"), engine),
      CONFIG,
      NOW,
    );
    expect(item.factors).toEqual([
      {
        key: "days_since_last_contact",
        name: "Days since last successful contact",
        valueLabel: "16 days",
        valueNumeric: 16,
        weight: "×1.5",
        pointsContributed: 24,
      },
    ]);
  });

  it("adapts triggered invariants to snake_case wire keys", () => {
    const engine = makeEngineOutput("p1", {
      triggeredInvariants: [
        {
          invariantId: "failed_attempts_tier1",
          displayLabel: "Failed Attempts >= 3",
        },
        {
          invariantId: "open_repair_tier1",
          displayLabel: "Open Repair",
          triggeringRecordId: "a0R5g00000XYZxQAO",
        },
      ],
    });
    const item = buildCaseloadItem(
      makeScored(makeSnapshot("p1", "owner-1"), engine),
      CONFIG,
      NOW,
    );
    expect(item.triggered_invariants).toEqual([
      {
        invariant_id: "failed_attempts_tier1",
        display_label: "Failed Attempts >= 3",
      },
      {
        invariant_id: "open_repair_tier1",
        display_label: "Open Repair",
        triggering_record_id: "a0R5g00000XYZxQAO",
      },
    ]);
  });
});

// ── P1H-04: secondaryFactorLabel ────────────────────────────────────────────

describe("buildCaseloadItem — secondaryFactorLabel (P1H-04)", () => {
  it("emits the second-highest-impact factor name when ≥2 factors carry non-zero impact", () => {
    // Factors listed in registry order (NOT impact order) — asserts the
    // derivation sorts by `pointsContributed` rather than trusting the input.
    const engine = makeEngineOutput("p1", {
      factors: [
        {
          name: "Failed contact attempts",
          key: "failed_attempts",
          valueLabel: "1 attempt",
          valueNumeric: 1,
          weight: "×1.0",
          weightRaw: 1,
          pointsContributed: 10,
        },
        {
          name: "Days since last successful contact",
          key: "days_since_last_contact",
          valueLabel: "16 days",
          valueNumeric: 16,
          weight: "×1.5",
          weightRaw: 1.5,
          pointsContributed: 24,
        },
        {
          name: "Voucher recertification deadline",
          key: "voucher_recert_deadline",
          valueLabel: "recert in 9 days",
          valueNumeric: 21,
          weight: "×3.0",
          weightRaw: 3,
          pointsContributed: 63,
        },
      ],
    });
    const item = buildCaseloadItem(
      makeScored(makeSnapshot("p1", "owner-1"), engine),
      CONFIG,
      NOW,
    );
    // Highest = voucher (63), second = days_since_last_contact (24).
    expect(item.secondaryFactorLabel).toBe(
      "Days since last successful contact",
    );
  });

  it("returns null when only one factor carries non-zero impact", () => {
    const engine = makeEngineOutput("p1", {
      factors: [
        {
          name: "Days since last successful contact",
          key: "days_since_last_contact",
          valueLabel: "16 days",
          valueNumeric: 16,
          weight: "×1.5",
          weightRaw: 1.5,
          pointsContributed: 24,
        },
        {
          name: "Failed contact attempts",
          key: "failed_attempts",
          valueLabel: "0 attempts",
          valueNumeric: 0,
          weight: "×1.0",
          weightRaw: 1,
          pointsContributed: 0,
        },
      ],
    });
    const item = buildCaseloadItem(
      makeScored(makeSnapshot("p1", "owner-1"), engine),
      CONFIG,
      NOW,
    );
    expect(item.secondaryFactorLabel).toBeNull();
  });

  it("breaks equal-impact ties by factor key ascending (mirrors pickHighestImpact)", () => {
    // Three factors with identical pointsContributed: a_factor wins primary by
    // key-asc, m_factor wins secondary, z_factor tails.
    const engine = makeEngineOutput("p1", {
      factors: [
        {
          name: "Z-factor",
          key: "z_factor",
          valueLabel: "v",
          valueNumeric: 10,
          weight: "×1.0",
          weightRaw: 1,
          pointsContributed: 10,
        },
        {
          name: "A-factor",
          key: "a_factor",
          valueLabel: "v",
          valueNumeric: 10,
          weight: "×1.0",
          weightRaw: 1,
          pointsContributed: 10,
        },
        {
          name: "M-factor",
          key: "m_factor",
          valueLabel: "v",
          valueNumeric: 10,
          weight: "×1.0",
          weightRaw: 1,
          pointsContributed: 10,
        },
      ],
    });
    const item = buildCaseloadItem(
      makeScored(makeSnapshot("p1", "owner-1"), engine),
      CONFIG,
      NOW,
    );
    expect(item.secondaryFactorLabel).toBe("M-factor");
  });
});

// ── snapshot-derived blocks ─────────────────────────────────────────────────

describe("buildCaseloadItem — derived day fields", () => {
  it("derives aftercareDay / lastSuccessfulContactDaysAgo / voucherRecertDays", () => {
    const snap = makeSnapshot("p1", "owner-1", {
      enrollment: {
        aftercareStartDate: new Date("2026-01-01T00:00:00Z"),
        mostRecentSuccessfulContact: new Date("2026-05-01T12:00:00Z"),
        voucherRecertDeadline: new Date("2026-06-14T12:00:00Z"),
      },
    });
    const item = buildCaseloadItem(
      makeScored(snap, makeEngineOutput("p1")),
      CONFIG,
      NOW,
    );
    expect(item.aftercareDay).toBe(134);
    expect(item.aftercareStartDate).toBe("2026-01-01");
    expect(item.lastSuccessfulContactDaysAgo).toBe(14);
    expect(item.voucherRecertDays).toBe(30);
  });

  it("returns null day fields when the source dates are absent", () => {
    const item = buildCaseloadItem(
      makeScored(makeSnapshot("p1", "owner-1"), makeEngineOutput("p1")),
      CONFIG,
      NOW,
    );
    expect(item.aftercareDay).toBeNull();
    expect(item.aftercareStartDate).toBeNull();
    expect(item.lastSuccessfulContactDaysAgo).toBeNull();
    expect(item.voucherRecertDays).toBeNull();
  });
});

describe("buildCaseloadItem — stabilityVisit", () => {
  it("flags 'upcoming' when the next checkpoint is within the lead-time window", () => {
    const snap = makeSnapshot("p1", "owner-1", {
      enrollment: { dueDates: dueDatesWith(new Date("2026-05-20T12:00:00Z")) },
    });
    const { stabilityVisit } = buildCaseloadItem(
      makeScored(snap, makeEngineOutput("p1")),
      CONFIG,
      NOW,
    );
    expect(stabilityVisit.status).toBe("upcoming");
    expect(stabilityVisit.statusLabel).toBe("Upcoming");
    expect(stabilityVisit.nextDueDate).toBe("2026-05-20");
  });

  it("flags 'on_track' when the checkpoint is beyond the lead-time window", () => {
    const snap = makeSnapshot("p1", "owner-1", {
      enrollment: { dueDates: dueDatesWith(new Date("2026-08-01T12:00:00Z")) },
    });
    const { stabilityVisit } = buildCaseloadItem(
      makeScored(snap, makeEngineOutput("p1")),
      CONFIG,
      NOW,
    );
    expect(stabilityVisit.status).toBe("on_track");
  });

  it("carries rollup counts and leaves checkpoint / scheduled time null", () => {
    const snap = makeSnapshot("p1", "owner-1", {
      enrollment: { checkInsCompleted: 3, missedCheckIns: 1 },
    });
    const { stabilityVisit } = buildCaseloadItem(
      makeScored(snap, makeEngineOutput("p1")),
      CONFIG,
      NOW,
    );
    expect(stabilityVisit.completedCount).toBe(3);
    expect(stabilityVisit.missedCount).toBe(1);
    expect(stabilityVisit.checkpoint).toBeNull();
    expect(stabilityVisit.scheduledVisitDateTime).toBeNull();
  });
});

describe("buildCaseloadItem — cycleStatus (F-05 / P1D-04)", () => {
  it("returns not_in_cycle when aftercareStartDate is null", () => {
    const { cycleStatus } = buildCaseloadItem(
      makeScored(makeSnapshot("p1", "owner-1"), makeEngineOutput("p1")),
      CONFIG,
      NOW,
    );
    expect(cycleStatus.state).toBe("not_in_cycle");
    expect(cycleStatus.daysToNext).toBeNull();
    expect(cycleStatus.daysOverdue).toBe(0);
    expect(cycleStatus.nextCheckpoint).toBeNull();
    expect(cycleStatus.lastCreditedCheckpoint).toBeNull();
  });

  it("returns pre_enrollment when aftercareStartDate is future-dated (VR-10)", () => {
    const snap = makeSnapshot("p1", "owner-1", {
      enrollment: {
        aftercareStartDate: new Date("2026-08-01T00:00:00Z"),
      },
    });
    const { cycleStatus } = buildCaseloadItem(
      makeScored(snap, makeEngineOutput("p1")),
      CONFIG,
      NOW,
    );
    expect(cycleStatus.state).toBe("pre_enrollment");
  });

  it("returns overdue for a participant 200 days into aftercare with no visit credits", () => {
    // NOW = 2026-05-15; aftercareStart = 200 days earlier (2025-10-27).
    // Past day-90 anchor with no credit → BR-29 overdue (no older miss yet).
    const start = new Date(NOW);
    start.setUTCDate(start.getUTCDate() - 200);
    const snap = makeSnapshot("p1", "owner-1", {
      enrollment: { aftercareStartDate: start },
    });
    const { cycleStatus } = buildCaseloadItem(
      makeScored(snap, makeEngineOutput("p1")),
      CONFIG,
      NOW,
    );
    // Day 90 missed (no credit), day 180 also passed without credit → catch_up.
    expect(["overdue", "catch_up"]).toContain(cycleStatus.state);
    expect(cycleStatus.daysOverdue).toBeGreaterThanOrEqual(1);
  });
});

describe("buildCaseloadItem — openBarriers", () => {
  it("includes only open (endDate null) Aftercare-stage barriers", () => {
    const snap = makeSnapshot("p1", "owner-1", {
      barriers: [
        makeBarrier({
          id: "b-open",
          type: "Cannot reach participant",
          stage: "Aftercare",
          startDate: new Date("2026-04-15T00:00:00Z"),
          endDate: null,
        }),
        makeBarrier({ id: "b-closed", stage: "Aftercare", endDate: new Date() }),
        makeBarrier({ id: "b-intake", stage: "Intake", endDate: null }),
      ],
    });
    const { openBarriers } = buildCaseloadItem(
      makeScored(snap, makeEngineOutput("p1")),
      CONFIG_WITH_SEVERITY,
      NOW,
    );
    expect(openBarriers).toHaveLength(1);
    expect(openBarriers[0]).toEqual({
      barrierId: "b-open",
      type: "Cannot reach participant",
      severity: "high",
      openedAt: "2026-04-15T00:00:00.000Z",
      ageDays: 30,
    });
  });

  it("resolves severity to null when the type is unclassified", () => {
    const snap = makeSnapshot("p1", "owner-1", {
      barriers: [
        makeBarrier({ id: "b1", type: "Some New Type", stage: "Aftercare" }),
      ],
    });
    const { openBarriers } = buildCaseloadItem(
      makeScored(snap, makeEngineOutput("p1")),
      CONFIG_WITH_SEVERITY,
      NOW,
    );
    expect(openBarriers[0]?.severity).toBeNull();
  });
});

describe("buildCaseloadItem — tags + dataIssues", () => {
  it("derives the P1H-03 RowTag chip cluster from snapshot fields", () => {
    // Lights up four signals at once — visit overdue, voucher in window,
    // recent incident, arrears — so the assertion proves wiring across the
    // four distinct snapshot collections (enrollment dates, voucher days,
    // incidents, arrears).
    const snap = makeSnapshot("p1", "owner-1", {
      enrollment: {
        // Strict past → visit_overdue (high)
        dueDates: dueDatesWith(new Date("2026-05-10T12:00:00Z")),
        // 9 days from NOW (2026-05-15) → voucher_critical_9d (high)
        voucherRecertDeadline: new Date("2026-05-24T12:00:00Z"),
      },
      incidents: [makeIncident({ incidentDate: new Date("2026-05-20T12:00:00Z") })],
      arrears: [makeArrear({ id: "a1" })],
    });
    const { tags } = buildCaseloadItem(
      makeScored(snap, makeEngineOutput("p1")),
      CONFIG,
      NOW,
    );
    expect(tags).toEqual([
      { key: "visit_overdue", label: "Visit overdue", severity: "high" },
      { key: "voucher_critical_9d", label: "Voucher 9d", severity: "high" },
      { key: "recent_incident", label: "Recent incident", severity: "med" },
      { key: "arrears", label: "Arrears", severity: "med" },
    ]);
  });

  it("emits the cannot_reach + failed_attempts pair off the BR-24 threshold", () => {
    // Confirms the DTO threads `configuration.tierInvariants.
    // failed_attempts_tier1_threshold` (FS v1.12 default 3) — not a tag-side
    // constant — into the derivation.
    const snap = makeSnapshot("p1", "owner-1", {
      enrollment: { checkInsAttempted: 3 },
    });
    const { tags } = buildCaseloadItem(
      makeScored(snap, makeEngineOutput("p1")),
      CONFIG,
      NOW,
    );
    expect(tags.map((t) => t.key)).toEqual(["cannot_reach", "failed_attempts"]);
  });

  it("does NOT emit aftercare_extended as a tag — P1H-14 moved it out of the TAGS cluster", () => {
    // The modifier is now rendered by `ProgramModifierChip` in the
    // PARTICIPANT cell off `item.aftercareExtended`. The dedicated
    // "buildCaseloadItem — aftercareExtended (P1H-14)" describe block
    // below pins the boolean projection.
    const snap = makeSnapshot("p1", "owner-1", {
      enrollment: {
        aftercareExtensionEndDate: new Date("2026-12-31T00:00:00Z"),
        aftercareExtended: true,
      },
    });
    const { tags } = buildCaseloadItem(
      makeScored(snap, makeEngineOutput("p1")),
      CONFIG,
      NOW,
    );
    expect(tags.map((t) => t.key)).not.toContain("aftercare_extended");
  });

  it("returns [] on a healthy row with no qualifying signals", () => {
    const snap = makeSnapshot("p1", "owner-1", {
      enrollment: { aftercareStartDate: new Date("2026-01-01T00:00:00Z") },
    });
    const { tags } = buildCaseloadItem(
      makeScored(snap, makeEngineOutput("p1")),
      CONFIG,
      NOW,
    );
    expect(tags).toEqual([]);
  });

  it("emits [] on a degraded row even when the snapshot still carries signals", () => {
    // The wireframe row treatment for a degraded row should never advertise
    // signals we couldn't score — DoD bullet on P1H-03.
    const snap = makeSnapshot("p1", "owner-1", {
      enrollment: {
        dueDates: dueDatesWith(new Date("2026-05-10T12:00:00Z")),
      },
      arrears: [makeArrear({ id: "a1" })],
    });
    const { tags } = buildCaseloadItem(
      makeScored(snap, /* engine */ null),
      CONFIG,
      NOW,
    );
    expect(tags).toEqual([]);
  });

  it("flags missing_aftercare_start_date and stale_factor_data in dataIssues", () => {
    const engine = makeEngineOutput("p1", {
      factors: [
        {
          name: "Voucher recertification deadline",
          key: "voucher_recert_deadline",
          valueLabel: "past due",
          valueNumeric: -5,
          weight: "×2.0",
          weightRaw: 2,
          pointsContributed: -10,
          dataQualityWarning: "recert deadline already past due",
        },
      ],
    });
    const item = buildCaseloadItem(
      makeScored(makeSnapshot("p1", "owner-1"), engine),
      CONFIG,
      NOW,
    );
    expect(item.dataIssues).toContain("missing_aftercare_start_date");
    expect(item.dataIssues).toContain("stale_factor_data");
  });

  it("returns an empty dataIssues array on a healthy row", () => {
    const snap = makeSnapshot("p1", "owner-1", {
      enrollment: { aftercareStartDate: new Date("2026-01-01T00:00:00Z") },
    });
    const item = buildCaseloadItem(
      makeScored(snap, makeEngineOutput("p1")),
      CONFIG,
      NOW,
    );
    expect(item.dataIssues).toEqual([]);
  });
});

// P1H-14 — the BR-19(h) Aftercare Extended modifier boolean projects
// straight through from `EnrollmentSnapshot.aftercareExtended` (itself
// derived in `packages/integrations/src/salesforce/bulk-hydration.ts`
// from `Aftercare_Extension_End_Date__c` because the SF object has no
// literal `Aftercare_Extended__c` checkbox per P0-08a). The SPA reads
// the boolean and renders `ProgramModifierChip` inline with displayName.
describe("buildCaseloadItem — aftercareExtended (P1H-14)", () => {
  it("projects true when the EnrollmentSnapshot.aftercareExtended flag is set", () => {
    const snap = makeSnapshot("p1", "owner-1", {
      enrollment: {
        aftercareExtensionEndDate: new Date("2026-12-31T00:00:00Z"),
        aftercareExtended: true,
      },
    });
    const item = buildCaseloadItem(
      makeScored(snap, makeEngineOutput("p1")),
      CONFIG,
      NOW,
    );
    expect(item.aftercareExtended).toBe(true);
  });

  it("projects false when the EnrollmentSnapshot.aftercareExtended flag is clear", () => {
    // Default fixture leaves aftercareExtended = false — covers the
    // common "no extension" case.
    const item = buildCaseloadItem(
      makeScored(makeSnapshot("p1", "owner-1"), makeEngineOutput("p1")),
      CONFIG,
      NOW,
    );
    expect(item.aftercareExtended).toBe(false);
  });

  it("projects false on a degraded row when the flag is clear", () => {
    // Degraded rows null out engine outputs (tier / factors / score), but
    // the modifier badge is a snapshot-derived program state and survives
    // a degraded engine pass.
    const item = buildCaseloadItem(
      makeScored(makeSnapshot("p1", "owner-1"), /* engine */ null),
      CONFIG,
      NOW,
    );
    expect(item.aftercareExtended).toBe(false);
  });

  it("projects true on a degraded row when the snapshot still carries the flag", () => {
    const snap = makeSnapshot("p1", "owner-1", {
      enrollment: {
        aftercareExtensionEndDate: new Date("2026-12-31T00:00:00Z"),
        aftercareExtended: true,
      },
    });
    const item = buildCaseloadItem(
      makeScored(snap, /* engine */ null),
      CONFIG,
      NOW,
    );
    expect(item.aftercareExtended).toBe(true);
  });
});

// P1H-10 — the wire field shape is in place behind the Pattern F flag
// (BR-21 / GAP-9). Until ratification + the upstream detection ticket ship,
// `buildCaseloadItem` MUST emit `pathCSuppression: null` for every row,
// regardless of snapshot shape — there is no projection wired into the DTO
// yet. These tests pin that invariant so the day the flip lands, anything
// that would have leaked a non-null value through the wire surface fails
// loudly here first.
describe("buildCaseloadItem — pathCSuppression (P1H-10 stub)", () => {
  it("is always null on a healthy row", () => {
    const item = buildCaseloadItem(
      makeScored(makeSnapshot("p1", "owner-1"), makeEngineOutput("p1")),
      CONFIG,
      NOW,
    );
    expect(item.pathCSuppression).toBeNull();
  });

  it("is always null on a degraded row", () => {
    const item = buildCaseloadItem(
      makeScored(makeSnapshot("p1", "owner-1"), /* engine */ null),
      CONFIG,
      NOW,
    );
    expect(item.pathCSuppression).toBeNull();
  });

  it("is always null even when other tag-source signals are populated", () => {
    // Mirrors the "lights up four signals at once" fixture above — proves
    // the stub invariant holds regardless of how rich the snapshot is.
    const snap = makeSnapshot("p1", "owner-1", {
      enrollment: {
        dueDates: dueDatesWith(new Date("2026-05-10T12:00:00Z")),
        voucherRecertDeadline: new Date("2026-05-24T12:00:00Z"),
        aftercareExtensionEndDate: new Date("2026-12-31T00:00:00Z"),
      },
      incidents: [makeIncident({ incidentDate: new Date("2026-05-20T12:00:00Z") })],
      arrears: [makeArrear({ id: "a1" })],
    });
    const item = buildCaseloadItem(
      makeScored(snap, makeEngineOutput("p1")),
      CONFIG,
      NOW,
    );
    expect(item.pathCSuppression).toBeNull();
  });

  it("does not emit path_c_suppression in the tags array (stub source ⇒ no chip)", () => {
    // Pattern F discipline: the derivation function (`deriveRowTags`) is in
    // production, but the always-null DTO data means the chip never lights.
    const item = buildCaseloadItem(
      makeScored(makeSnapshot("p1", "owner-1"), makeEngineOutput("p1")),
      CONFIG,
      NOW,
    );
    expect(item.tags.map((t) => t.key)).not.toContain("path_c_suppression");
  });
});

// ── P1H-02: perCheckpointBreakdown (F-05 / BR-33) ───────────────────────────

describe("buildCaseloadItem — perCheckpointBreakdown (F-05 / BR-33)", () => {
  it("emits a four-anchor breakdown for an in-cycle participant", () => {
    // NOW = 2026-05-15; aftercareStart = 200 days earlier — past day-90 anchor.
    const start = new Date(NOW);
    start.setUTCDate(start.getUTCDate() - 200);
    const snap = makeSnapshot("p1", "owner-1", {
      enrollment: { aftercareStartDate: start },
    });
    const { perCheckpointBreakdown } = buildCaseloadItem(
      makeScored(snap, makeEngineOutput("p1")),
      CONFIG,
      NOW,
    );
    expect(perCheckpointBreakdown.map((row) => row.anchor)).toEqual([
      90, 180, 270, 365,
    ]);
  });

  it("matches the detail-page builder byte-for-byte for the same snapshot", () => {
    const start = new Date(NOW);
    start.setUTCDate(start.getUTCDate() - 200);
    const snap = makeSnapshot("p1", "owner-1", {
      enrollment: { aftercareStartDate: start },
    });
    const { perCheckpointBreakdown } = buildCaseloadItem(
      makeScored(snap, makeEngineOutput("p1")),
      CONFIG,
      NOW,
    );
    // Detail-page emission for the same snapshot — the field is the same
    // function reused via @anthos/api, so the rows must be deep-equal.
    expect(perCheckpointBreakdown).toEqual(
      buildPerCheckpointBreakdown(snap.enrollment, NOW),
    );
  });

  it("emits the breakdown on every item in a multi-row body", () => {
    const start = new Date(NOW);
    start.setUTCDate(start.getUTCDate() - 200);
    const snap1 = makeSnapshot("p1", "owner-1", {
      enrollment: { aftercareStartDate: start },
    });
    const snap2 = makeSnapshot("p2", "owner-1");
    const items = [
      buildCaseloadItem(makeScored(snap1, makeEngineOutput("p1")), CONFIG, NOW),
      buildCaseloadItem(makeScored(snap2, makeEngineOutput("p2")), CONFIG, NOW),
    ];
    expect(
      items.every((item) =>
        Object.prototype.hasOwnProperty.call(item, "perCheckpointBreakdown"),
      ),
    ).toBe(true);
  });

  it("still computes the breakdown from the snapshot when the engine result is null", () => {
    // The detail page derives the breakdown from `snapshot.enrollment` alone,
    // independent of the engine result. A caseload row that lost its score
    // (`engine === null`) still has a snapshot, so the breakdown stays in
    // parity with what the detail page would emit for the same participant.
    const start = new Date(NOW);
    start.setUTCDate(start.getUTCDate() - 200);
    const snap = makeSnapshot("p1", "owner-1", {
      enrollment: { aftercareStartDate: start },
    });
    const item = buildCaseloadItem(makeScored(snap, null), CONFIG, NOW);
    expect(item.dataIssues).toContain("degraded_score");
    expect(item.perCheckpointBreakdown).toEqual(
      buildPerCheckpointBreakdown(snap.enrollment, NOW),
    );
  });
});

// ── degraded rows ───────────────────────────────────────────────────────────

describe("buildCaseloadItem — degraded row", () => {
  it("nulls every engine field and flags degraded_score", () => {
    const item = buildCaseloadItem(
      makeScored(makeSnapshot("p1", "owner-1"), null),
      CONFIG,
      NOW,
    );
    expect(item.tier).toBeNull();
    expect(item.tierLabel).toBeNull();
    expect(item.priorityScore).toBeNull();
    expect(item.priorityModifier).toBeNull();
    expect(item.highestImpactFactor).toBeNull();
    expect(item.factors).toEqual([]);
    expect(item.secondaryFactorLabel).toBeNull();
    expect(item.triggered_invariants).toEqual([]);
    expect(item.dataIssues).toContain("degraded_score");
  });
});

// ── P1H-01: displayName + peLabel + programCode ─────────────────────────────

describe("buildCaseloadItem — P1H-01 display fields", () => {
  it("carries displayName / peLabel / programCode from the snapshot enrollment", () => {
    const snap = makeSnapshot("p1", "owner-1", {
      enrollment: {
        displayName: "John Stone",
        peName: "GRAD John Stone - 09/2023",
        programCode: "ACS",
      },
    });
    const item = buildCaseloadItem(
      makeScored(snap, makeEngineOutput("p1")),
      CONFIG,
      NOW,
    );
    expect(item.displayName).toBe("John Stone");
    expect(item.peLabel).toBe("09/2023");
    expect(item.programCode).toBe("ACS");
  });

  it("preserves a multi-value programCode (semicolon-joined picklist)", () => {
    const snap = makeSnapshot("p1", "owner-1", {
      enrollment: { programCode: "ACS;HHN" },
    });
    const item = buildCaseloadItem(
      makeScored(snap, makeEngineOutput("p1")),
      CONFIG,
      NOW,
    );
    expect(item.programCode).toBe("ACS;HHN");
  });

  it("extracts peLabel from a single-digit-month PE Name", () => {
    const snap = makeSnapshot("p1", "owner-1", {
      enrollment: { peName: "Maria Santos - 9/2024" },
    });
    const item = buildCaseloadItem(
      makeScored(snap, makeEngineOutput("p1")),
      CONFIG,
      NOW,
    );
    expect(item.peLabel).toBe("9/2024");
  });

  it("returns null peLabel when the Name lacks a MM/YYYY suffix", () => {
    const snap = makeSnapshot("p1", "owner-1", {
      enrollment: { peName: "Some unexpected naming" },
    });
    const item = buildCaseloadItem(
      makeScored(snap, makeEngineOutput("p1")),
      CONFIG,
      NOW,
    );
    expect(item.peLabel).toBeNull();
  });

  it("returns nulls for the three fields when the snapshot has them null (degraded SF row)", () => {
    const item = buildCaseloadItem(
      makeScored(makeSnapshot("p1", "owner-1"), makeEngineOutput("p1")),
      CONFIG,
      NOW,
    );
    expect(item.displayName).toBeNull();
    expect(item.peLabel).toBeNull();
    expect(item.programCode).toBeNull();
  });

  it("carries the three fields even when the engine result is null (per-row degradation)", () => {
    const snap = makeSnapshot("p1", "owner-1", {
      enrollment: {
        displayName: "Edna Hunt",
        peName: "GRAD Edna Hunt - 07/2023",
        programCode: "ACS",
      },
    });
    const item = buildCaseloadItem(makeScored(snap, null), CONFIG, NOW);
    expect(item.displayName).toBe("Edna Hunt");
    expect(item.peLabel).toBe("07/2023");
    expect(item.programCode).toBe("ACS");
    expect(item.dataIssues).toContain("degraded_score");
  });
});

describe("buildCaseloadItem — PII discipline (Immutable #1)", () => {
  it("still omits the not-yet-needed PII fields", () => {
    const item = buildCaseloadItem(
      makeScored(makeSnapshot("p1", "owner-1"), makeEngineOutput("p1")),
      CONFIG,
      NOW,
    );
    const keys = Object.keys(item);
    expect(keys).not.toContain("enrollmentCode");
    expect(keys).not.toContain("preferredContactMethod");
    expect(keys).not.toContain("communicationConsent");
  });
});

describe("stripPiiForCache", () => {
  function buildBodyWithDisplayNames(): CaseloadBody {
    const snap1 = makeSnapshot("p1", "owner-1", {
      enrollment: {
        displayName: "John Stone",
        peName: "GRAD John Stone - 09/2023",
        programCode: "ACS",
      },
    });
    const snap2 = makeSnapshot("p2", "owner-1", {
      enrollment: {
        displayName: "Bessie Alvarez",
        peName: "GRAD Bessie Alvarez - 08/2023",
        programCode: "HHN",
      },
    });
    return buildCaseloadBody({
      specialistId: "0058K00000XYZAbQAO",
      queueId: "caseload_overview",
      queueCounts: { caseload_overview: 2 },
      cacheAgeSeconds: 0,
      configurationVersion: 0,
      items: [
        buildCaseloadItem(makeScored(snap1, makeEngineOutput("p1")), CONFIG, NOW),
        buildCaseloadItem(makeScored(snap2, makeEngineOutput("p2")), CONFIG, NOW),
      ],
    });
  }

  it("nulls displayName on every item", () => {
    const stripped = stripPiiForCache(buildBodyWithDisplayNames());
    expect(stripped.items.every((item) => item.displayName === null)).toBe(true);
  });

  it("preserves peLabel and programCode (not PII)", () => {
    const stripped = stripPiiForCache(buildBodyWithDisplayNames());
    expect(stripped.items.map((i) => i.peLabel)).toEqual([
      "09/2023",
      "08/2023",
    ]);
    expect(stripped.items.map((i) => i.programCode)).toEqual(["ACS", "HHN"]);
  });

  it("does not mutate the input body", () => {
    const body = buildBodyWithDisplayNames();
    const before = body.items[0]?.displayName;
    stripPiiForCache(body);
    expect(body.items[0]?.displayName).toBe(before);
  });

  it("preserves engine-derived and envelope fields", () => {
    const body = buildBodyWithDisplayNames();
    const stripped = stripPiiForCache(body);
    expect(stripped.specialistId).toBe(body.specialistId);
    expect(stripped.queue).toBe(body.queue);
    expect(stripped.queueCounts).toEqual(body.queueCounts);
    expect(stripped.items.length).toBe(body.items.length);
    expect(stripped.items[0]?.tier).toBe(body.items[0]?.tier);
    expect(stripped.items[0]?.priorityScore).toBe(body.items[0]?.priorityScore);
  });
});

// ── envelope ────────────────────────────────────────────────────────────────

describe("buildCaseloadBody", () => {
  it("assembles the E-06 envelope with sort fixed to priority_desc (BR-21)", () => {
    const body = buildCaseloadBody({
      specialistId: "0058K00000XYZAbQAO",
      queueId: "check_ins_due_this_month",
      queueCounts: { "check_ins_due_this_month": 5, "caseload_overview": 12 },
      cacheAgeSeconds: 0,
      configurationVersion: 0,
      items: [],
    });
    expect(body.specialistId).toBe("0058K00000XYZAbQAO");
    expect(body.queue).toBe("check_ins_due_this_month");
    expect(body.sort).toBe("priority_desc");
    expect(body.configurationVersion).toBe(0);
    expect(body.queueCounts).toEqual({
      "check_ins_due_this_month": 5,
      "caseload_overview": 12,
    });
  });
});
