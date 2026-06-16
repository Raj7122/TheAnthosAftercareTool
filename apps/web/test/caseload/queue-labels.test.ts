import { describe, expect, it } from "vitest";

import {
  DEFAULT_LANDING_QUEUE_ID,
  queueLabel,
} from "../../app/caseload/_lib/queue-labels";

describe("queueLabel", () => {
  it("returns human-readable labels for the four BR-22 queues", () => {
    expect(queueLabel("caseload_overview")).toBe("Caseload overview");
    expect(queueLabel("due_soon")).toBe("Due soon");
    expect(queueLabel("never_successfully_contacted")).toBe(
      "Never contacted",
    );
    expect(queueLabel("check_ins_due_this_month")).toBe(
      "Check-ins due this month",
    );
  });

  it("falls through to the id itself for unknown queue ids (BR-22 config-driven)", () => {
    expect(queueLabel("some_future_queue")).toBe("some_future_queue");
  });
});

describe("DEFAULT_LANDING_QUEUE_ID", () => {
  it("matches Q-DEMO-1 — 'Due soon' (today's action queue)", () => {
    expect(DEFAULT_LANDING_QUEUE_ID).toBe("due_soon");
  });
});
