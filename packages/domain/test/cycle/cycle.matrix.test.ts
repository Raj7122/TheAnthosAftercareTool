import { describe, expect, it } from "vitest";

import {
  computeCheckpointState,
  computePerCheckpointStates,
  creditCheckpoint,
} from "../../src/cycle/index.js";
import type { CheckpointState } from "../../src/cycle/types.js";

import { makeParticipantCycle, utcDate } from "./_fixtures.js";

// P1D-05 — comprehensive F-05 cycle regression net.
//
// Covers the combined behavior of:
//   - P1D-01 `computeCheckpointState` (aggregate state, BR-28..BR-33)
//   - P1D-02 `creditCheckpoint`        (BR-25 nearest-preceding credit, TR-STAB-3)
//   - P1D-03 `computePerCheckpointStates` (BR-26 Option A per-anchor, TR-STAB-4)
//
// Cycle-state regression net governed by TR-STAB-3 (BR-25 nearest-preceding
// credit) and TR-STAB-4 (BR-26 Option A catch-up). If a future refactor
// breaks the canonical BR-25 example (day 200 → 180) or BR-26 Option A
// persistence (missed checkpoints stay surfaced through later credits), this
// suite is the first place that should fail.
//
// Anchor calendar (start = 2026-01-01):
//   90  → 2026-04-01      180 → 2026-06-30
//   270 → 2026-09-28      365 → 2027-01-01
//   cycle ends at 365 + 14-day grace → 2027-01-15
//
// All Date values flow through `utcDate(yyyyMmDd)` so test bodies stay free of
// `new Date()` (per ticket AC: "deterministic `current_date` injection — no
// `new Date()` inside test bodies").

const START = "2026-01-01" as const;

// ---------------------------------------------------------------------------
// All 8 aggregate states that `computeCheckpointState` can emit.
// ---------------------------------------------------------------------------
//
// `CheckpointState` in `packages/domain/src/cycle/types.ts` declares NINE
// string-literal members, but `future` is per-anchor only — the inline
// comment at `types.ts:18` notes "`computeCheckpointState` aggregates this as
// `pre_enrollment` or `between` and never emits `future` directly". So the
// aggregate-state count the ticket cites is 8.
//
// This array is typed as `readonly CheckpointState[]` so removing one of the
// eight from the source type would surface as a TypeScript compile error
// here; adding a new aggregate state would slip past TS but fail the runtime
// length guard below.
const AGGREGATE_STATES: readonly CheckpointState[] = [
  "not_in_cycle",
  "pre_enrollment",
  "due",
  "overdue",
  "between",
  "complete",
  "catch_up",
  "cycle_complete",
];

describe("F-05 cycle matrix — all 8 aggregate states from computeCheckpointState", () => {
  it("declares exactly 8 aggregate states (surface drift to P1D-01 author)", () => {
    // If this fails because the count went up, the new state needs a landing
    // test in the matrix. If it went down, P1D-01's contract has shrunk and
    // the AGGREGATE_STATES literal above needs to be reconciled with
    // `CheckpointState` in `cycle/types.ts`.
    expect(AGGREGATE_STATES).toHaveLength(8);
    expect(new Set(AGGREGATE_STATES).size).toBe(AGGREGATE_STATES.length);
  });

  it("lands `not_in_cycle` when aftercareStartDate is null (BR-32 / FS-12)", () => {
    const out = computeCheckpointState(
      makeParticipantCycle({ start: null, today: "2026-05-22" }),
    );
    expect(out).toStrictEqual({
      checkpointState: "not_in_cycle",
      daysToNext: null,
      daysOverdue: 0,
      nextCheckpoint: null,
      lastCreditedCheckpoint: null,
    });
  });

  it("lands `pre_enrollment` when start date is in the future (VR-10)", () => {
    const out = computeCheckpointState(
      makeParticipantCycle({ start: "2026-06-01", today: "2026-05-22" }),
    );
    expect(out.checkpointState).toBe("pre_enrollment");
    expect(out.nextCheckpoint).toBe(90);
    expect(out.lastCreditedCheckpoint).toBeNull();
  });

  it("lands `due` when next anchor is inside DUE_WINDOW_DAYS (BR-28)", () => {
    // Day 83 — 7 days before the 90 anchor at 2026-04-01.
    const out = computeCheckpointState(
      makeParticipantCycle({ start: START, today: "2026-03-25" }),
    );
    expect(out.checkpointState).toBe("due");
    expect(out.nextCheckpoint).toBe(90);
    expect(out.daysToNext).toBe(7);
    expect(out.daysOverdue).toBe(0);
  });

  it("lands `overdue` when most-recent passed anchor is uncredited and no older miss (BR-29)", () => {
    // Day 95 — 90 anchor passed 5 days ago, no visit logged.
    const out = computeCheckpointState(
      makeParticipantCycle({ start: START, today: "2026-04-06" }),
    );
    expect(out.checkpointState).toBe("overdue");
    expect(out.daysOverdue).toBe(5);
    expect(out.nextCheckpoint).toBe(180);
    expect(out.lastCreditedCheckpoint).toBeNull();
  });

  it("lands `between` when last passed is credited and next is beyond due window (BR-31 adjacent)", () => {
    // Day 100 — 90 anchor credited (visit on day 94); next anchor 180 is
    // ~80 days out, well beyond the 14-day due window.
    const out = computeCheckpointState(
      makeParticipantCycle({
        start: START,
        today: "2026-04-11",
        visits: ["2026-04-05"],
      }),
    );
    expect(out.checkpointState).toBe("between");
    expect(out.nextCheckpoint).toBe(180);
    expect(out.lastCreditedCheckpoint).toBe(90);
    expect(out.daysOverdue).toBe(0);
    expect(out.daysToNext).toBeGreaterThan(14);
  });

  it("lands `complete` when all four anchors credited and inside 365 + 14-day grace (BR-31)", () => {
    // Day 370 — past day 365 anchor but inside the 14-day grace; four visits
    // credit each anchor → no uncredited passed → no next anchor → complete.
    const out = computeCheckpointState(
      makeParticipantCycle({
        start: START,
        today: "2027-01-06",
        visits: ["2026-04-02", "2026-07-02", "2026-09-30", "2027-01-02"],
      }),
    );
    expect(out.checkpointState).toBe("complete");
    expect(out.lastCreditedCheckpoint).toBe(365);
    expect(out.nextCheckpoint).toBeNull();
    expect(out.daysToNext).toBeNull();
  });

  it("lands `catch_up` when an older anchor is missed behind a later credit (BR-33 Purple+!)", () => {
    // Day 200 — 90 anchor uncredited (no visit before day 90); 180 anchor
    // credited (visit day 185 → BR-25 maps to 180). Most recent passed (180)
    // is credited, so the single miss is "behind" → catch_up, not overdue.
    const out = computeCheckpointState(
      makeParticipantCycle({
        start: START,
        today: "2026-07-20",
        visits: ["2026-07-05"],
      }),
    );
    expect(out.checkpointState).toBe("catch_up");
    expect(out.lastCreditedCheckpoint).toBe(180);
    expect(out.nextCheckpoint).toBe(270);
  });

  it("lands `cycle_complete` when currentDate is past day 365 + 14-day grace (AC-21)", () => {
    // Day 380 — past start + 379 (cycle end). The state holds regardless of
    // credit history (J-05 graduation owns post-cycle handling).
    const out = computeCheckpointState(
      makeParticipantCycle({ start: START, today: "2027-01-16" }),
    );
    expect(out.checkpointState).toBe("cycle_complete");
    expect(out.nextCheckpoint).toBeNull();
    expect(out.daysToNext).toBeNull();
  });
});

describe("F-05 cycle matrix — BR-25 nearest-preceding credit (TR-STAB-3)", () => {
  it("CANONICAL: visit on day 200 credits the 180 anchor", () => {
    // The FS F-05 canonical example. If this assertion ever fails, BR-25
    // attribution is broken — every downstream Tier 1 floor calibration
    // depends on it.
    expect(creditCheckpoint(utcDate(START), utcDate("2026-07-20"))).toBe(180);
  });

  it("visit on exact boundary day 90 credits 90", () => {
    expect(creditCheckpoint(utcDate(START), utcDate("2026-04-01"))).toBe(90);
  });

  it("visit on exact boundary day 180 credits 180", () => {
    expect(creditCheckpoint(utcDate(START), utcDate("2026-06-30"))).toBe(180);
  });

  it("visit on exact boundary day 270 credits 270", () => {
    expect(creditCheckpoint(utcDate(START), utcDate("2026-09-28"))).toBe(270);
  });

  it("visit on exact boundary day 365 credits 365 (EC-16)", () => {
    expect(creditCheckpoint(utcDate(START), utcDate("2027-01-01"))).toBe(365);
  });

  it("visit on day 89 credits no anchor (pre-90 floor)", () => {
    expect(creditCheckpoint(utcDate(START), utcDate("2026-03-31"))).toBeNull();
  });

  it("visit dated before aftercareStartDate credits no anchor", () => {
    expect(
      creditCheckpoint(utcDate(START), utcDate("2025-12-15")),
    ).toBeNull();
  });

  it("two visits inside the same anchor window credit that anchor exactly once (P1D-02 AC #5)", () => {
    // Two visits at days 94 and 99 — both inside the 90-window. The
    // credited flag is idempotent: lastCreditedCheckpoint stays at 90 (not
    // 180), and the per-anchor breakdown shows exactly one `complete`.
    const input = makeParticipantCycle({
      start: START,
      today: "2026-04-11",
      visits: ["2026-04-05", "2026-04-10"],
    });
    const aggregate = computeCheckpointState(input);
    expect(aggregate.lastCreditedCheckpoint).toBe(90);
    expect(aggregate.nextCheckpoint).toBe(180);
    const perAnchor = computePerCheckpointStates(input);
    const completeCount = perAnchor.filter((p) => p.state === "complete").length;
    expect(completeCount).toBe(1);
  });

  it("VR-11 caller-boundary at the `creditCheckpoint` primitive: no currentDate parameter, no implicit filter", () => {
    // `creditCheckpoint` has no `currentDate` parameter; `types.ts:38`
    // documents "VR-11: a credited visit's service date must be ≤ today.
    // Caller enforces." This test pins that contract at the primitive
    // layer — the visit date alone determines crediting. The companion
    // aggregate-layer test in the edge-cases block exercises the same
    // boundary through `computeCheckpointState`; both exist on purpose to
    // catch a future "implicit filter" refactor at EITHER layer.
    expect(creditCheckpoint(utcDate(START), utcDate("2026-07-20"))).toBe(180);
  });
});

describe("F-05 cycle matrix — BR-26 Option A catch-up (TR-STAB-4)", () => {
  it("CANONICAL Option A: 180 missed + 270 credited → 180 stays catch_up, not auto-cleared", () => {
    // Today day 282. Visit on day 95 credits 90; visit on day 275 credits
    // 270; 180 was never logged. Option A: completing 270 does NOT clear
    // the 180 miss — it surfaces persistently until a BR-25-credited visit
    // is logged at the missed anchor.
    const perAnchor = computePerCheckpointStates(
      makeParticipantCycle({
        start: START,
        today: "2026-10-10",
        visits: ["2026-04-05", "2026-10-03"],
      }),
    );
    expect(perAnchor).toStrictEqual([
      { anchor: 90, state: "complete" },
      { anchor: 180, state: "catch_up" },
      { anchor: 270, state: "complete" },
      { anchor: 365, state: "future" },
    ]);
  });

  it("stacked misses: 180 + 270 both missed + 365 credited → both stay catch_up; 365 complete", () => {
    // Day 370 (inside the grace window). Visits: day 94 (→ 90) + day 366
    // (→ 365). 180 and 270 were never logged and both sit "behind" the
    // credited 365 anchor → both surface as catch_up. Per the per-anchor
    // contract, the freshest miss is whichever uncredited anchor IS the
    // most-recent passed; here 365 is credited, so neither 180 nor 270 is
    // the "freshest miss" → both classify as catch_up (Option A surface).
    //
    // The ticket AC phrases this as "both 180 and 270 surface as overdue
    // per BR-26 Option A" — the spec-level visualization name for the
    // continued call-to-action is `catch_up` (BR-33 Purple+!), which IS
    // the per-anchor flavor of "still overdue and needs to be done."
    const perAnchor = computePerCheckpointStates(
      makeParticipantCycle({
        start: START,
        today: "2027-01-06",
        visits: ["2026-04-04", "2027-01-02"],
      }),
    );
    expect(perAnchor).toStrictEqual([
      { anchor: 90, state: "complete" },
      { anchor: 180, state: "catch_up" },
      { anchor: 270, state: "catch_up" },
      { anchor: 365, state: "complete" },
    ]);
  });

  it("logging a BR-25-credited visit at the missed anchor flips its catch_up to complete", () => {
    // Same setup as the canonical Option A test plus a day-200 visit
    // (→ BR-25 credits 180). That single visit is what flips 180 from
    // catch_up to complete; no other anchor changes.
    const perAnchor = computePerCheckpointStates(
      makeParticipantCycle({
        start: START,
        today: "2026-10-10",
        visits: ["2026-04-05", "2026-07-20", "2026-10-03"],
      }),
    );
    expect(perAnchor).toStrictEqual([
      { anchor: 90, state: "complete" },
      { anchor: 180, state: "complete" },
      { anchor: 270, state: "complete" },
      { anchor: 365, state: "future" },
    ]);
  });

  it("aggregate `catch_up` co-displays the next upcoming checkpoint (BR-27)", () => {
    // BR-27 (catch-up + upcoming co-display) lives inside the BR-26
    // describe block because the same Option A fixture exercises both
    // requirements. The aggregate state is `catch_up` and `nextCheckpoint`
    // still nominates the upcoming anchor so the UI can render both the
    // catch-up CTA AND the upcoming-anchor countdown side-by-side.
    const aggregate = computeCheckpointState(
      makeParticipantCycle({
        start: START,
        today: "2026-10-10",
        visits: ["2026-04-05", "2026-10-03"],
      }),
    );
    expect(aggregate.checkpointState).toBe("catch_up");
    expect(aggregate.nextCheckpoint).toBe(365);
    expect(aggregate.lastCreditedCheckpoint).toBe(270);
  });
});

describe("F-05 cycle matrix — edge cases (ticket scope)", () => {
  it("aftercareStartDate=null → not_in_cycle sentinel; daysToNext/daysOverdue all zeroed", () => {
    const out = computeCheckpointState(
      makeParticipantCycle({
        start: null,
        today: "2026-05-22",
        visits: ["2026-04-05"], // ignored — no cycle to credit against
      }),
    );
    expect(out.checkpointState).toBe("not_in_cycle");
    expect(out.daysToNext).toBeNull();
    expect(out.daysOverdue).toBe(0);
    expect(out.nextCheckpoint).toBeNull();
    expect(out.lastCreditedCheckpoint).toBeNull();
    // Per-anchor breakdown is the empty array, matching BR-32 / FS-12.
    expect(
      computePerCheckpointStates(
        makeParticipantCycle({ start: null, today: "2026-05-22" }),
      ),
    ).toStrictEqual([]);
  });

  it("visit dated before aftercareStartDate does not credit any checkpoint", () => {
    // Pre-start visits return null from `creditCheckpoint` and do not flip
    // the aggregate state — day 95 with a single pre-start visit still
    // reads as `overdue` (the 90 anchor remains uncredited).
    const out = computeCheckpointState(
      makeParticipantCycle({
        start: START,
        today: "2026-04-06",
        visits: ["2025-12-15"],
      }),
    );
    expect(out.checkpointState).toBe("overdue");
    expect(out.lastCreditedCheckpoint).toBeNull();
  });

  it("exact boundary: visit on day 90 credits 90 (not the day-89 null)", () => {
    // Boundary contrast: 2026-03-31 (day 89) credits null; 2026-04-01
    // (day 90) credits 90. Asserting both sides of the boundary in one
    // test makes the off-by-one regression unmissable.
    expect(creditCheckpoint(utcDate(START), utcDate("2026-03-31"))).toBeNull();
    expect(creditCheckpoint(utcDate(START), utcDate("2026-04-01"))).toBe(90);
  });

  it("two visits on the same calendar day at one checkpoint credit it exactly once", () => {
    // AC: "two visits at the same checkpoint (e.g., both on day 95) →
    // checkpoint credited once, second visit is a no-op for crediting."
    const input = makeParticipantCycle({
      start: START,
      today: "2026-04-11",
      visits: ["2026-04-06", "2026-04-06"], // both day 95
    });
    expect(computeCheckpointState(input).lastCreditedCheckpoint).toBe(90);
    const perAnchor = computePerCheckpointStates(input);
    expect(perAnchor[0]).toStrictEqual({ anchor: 90, state: "complete" });
  });

  it("VR-11 caller-boundary at the `computeCheckpointState` aggregate: today=day 100 + visit on day 200 still credits 180", () => {
    // Aggregate-layer companion to the BR-25-block primitive test. The
    // visit date is FUTURE relative to `today` (day 200 vs day 100), and
    // yet the aggregate function credits 180 — confirming VR-11 enforcement
    // does not live inside `computeCheckpointState` either. The ticket AC
    // "visit dated in the future relative to `current_date` → does not
    // credit" is therefore a SYSTEM-LEVEL invariant (Salesforce adapter
    // filters future-dated visits out of `completedStabilityMeetings`),
    // not a function-level one. This test pins the contract boundary so a
    // future "implicit filter" refactor would force a caller-boundary
    // review rather than silently changing behavior.
    const out = computeCheckpointState(
      makeParticipantCycle({
        start: START,
        today: "2026-04-11", // day 100
        visits: ["2026-07-20"], // day 200 — future relative to today
      }),
    );
    expect(out.lastCreditedCheckpoint).toBe(180);
  });

  it("stacked missed checkpoints 180 + 270 with 365 credited surface both as catch_up (BR-26)", () => {
    // Aggregate view of the same fixture as the per-anchor "stacked misses"
    // test above. Multiple misses with the most-recent passed credited →
    // aggregate is `catch_up`; daysOverdue counts to the FRESHEST miss
    // (270 anchor at 2026-09-28 → today 2027-01-06 = 100 days).
    const out = computeCheckpointState(
      makeParticipantCycle({
        start: START,
        today: "2027-01-06",
        visits: ["2026-04-04", "2027-01-02"],
      }),
    );
    expect(out.checkpointState).toBe("catch_up");
    expect(out.lastCreditedCheckpoint).toBe(365);
    expect(out.daysOverdue).toBe(100);
  });
});

describe("F-05 cycle matrix — determinism / calibration regression net", () => {
  it("the canonical day-200 → 180 assertion is stable across 100 invocations", () => {
    // The single most-cited BR-25 example in the spec. Repeated execution
    // pins purity (no Date.now, no module-level state) and protects the
    // calibration-relevant cycle floor under TR-STAB-3.
    for (let i = 0; i < 100; i++) {
      expect(creditCheckpoint(utcDate(START), utcDate("2026-07-20"))).toBe(180);
    }
  });

  it("aggregate + per-anchor agree under the canonical Option A fixture (P1D-01 ↔ P1D-03)", () => {
    const input = makeParticipantCycle({
      start: START,
      today: "2026-10-10",
      visits: ["2026-04-05", "2026-10-03"],
    });
    const aggregate = computeCheckpointState(input);
    const perAnchor = computePerCheckpointStates(input);
    // Aggregate says `catch_up`; per-anchor shows the 180 miss as `catch_up`
    // while the most-recent passed (270) is `complete`. Consistency check.
    expect(aggregate.checkpointState).toBe("catch_up");
    const one80 = perAnchor.find((p) => p.anchor === 180);
    expect(one80?.state).toBe("catch_up");
    const two70 = perAnchor.find((p) => p.anchor === 270);
    expect(two70?.state).toBe("complete");
  });
});
