import { describe, expect, it } from "vitest";

import { queuePredicatesSchema } from "../../src/config/index.js";
import { getCalibrationConfiguration } from "../../src/priority/index.js";

// P1C-05 — the config seed must carry the F-04 BR-22 queue universe so that
// P0-15 (lock v1) and the tuning rig propagate it into the versioned
// `configuration` row. These assertions pin the four demo-path queues, the
// Q-DEMO-1 default, the BR-21 sort, and the BR-22 predicate thresholds.
describe("getCalibrationConfiguration() — queue universe (F-04 BR-22)", () => {
  const queues = getCalibrationConfiguration().queuePredicates;

  it("parses cleanly through queuePredicatesSchema (FS-11 fail-loud)", () => {
    expect(queuePredicatesSchema.safeParse(queues).success).toBe(true);
  });

  it("declares the four spec'd queues", () => {
    expect(Object.keys(queues).sort()).toEqual([
      "caseload_overview",
      "check_ins_due_this_month",
      "due_soon",
      "never_successfully_contacted",
    ]);
  });

  it("makes 'Check-ins due this month' the single default queue (Q-DEMO-1)", () => {
    const defaults = Object.entries(queues).filter(([, q]) => q.isDefault);
    expect(defaults).toHaveLength(1);
    expect(defaults[0]?.[0]).toBe("check_ins_due_this_month");
  });

  it("sorts every queue by priority score descending (BR-21)", () => {
    for (const queue of Object.values(queues)) {
      expect(queue.sortKey).toBe("priority_score_desc");
    }
  });

  it("carries the BR-22 predicate thresholds (30 / 28 / 2)", () => {
    expect(queues["caseload_overview"]?.predicate).toEqual({
      kind: "all_active",
    });
    expect(queues["due_soon"]?.predicate).toEqual({
      kind: "due_within_days",
      params: { days: 30 },
    });
    expect(queues["never_successfully_contacted"]?.predicate).toEqual({
      kind: "never_successfully_contacted",
      params: { minFailedAttempts: 2 },
    });
    expect(queues["check_ins_due_this_month"]?.predicate).toEqual({
      kind: "successful_contact_overdue",
      params: { minDaysSinceContact: 28, currentCalendarMonthOnly: true },
    });
  });
});
