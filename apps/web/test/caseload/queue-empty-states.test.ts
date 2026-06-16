import { describe, expect, it } from "vitest";

import { queueEmptyState } from "../../app/caseload/_lib/queue-empty-states";

describe("queueEmptyState", () => {
  it("returns queue-appropriate copy for each of the four BR-22 queues", () => {
    expect(queueEmptyState("caseload_overview")).toBe(
      "No participants in your caseload yet.",
    );
    expect(queueEmptyState("due_soon")).toBe(
      "No check-ins coming due in the next few days.",
    );
    expect(queueEmptyState("never_successfully_contacted")).toBe(
      "Everyone in your caseload has been reached at least once.",
    );
    expect(queueEmptyState("check_ins_due_this_month")).toBe(
      "All caught up for this month.",
    );
  });

  it("falls through to a generic message for unknown queue ids (BR-22 config-driven)", () => {
    expect(queueEmptyState("some_future_queue")).toBe(
      "No participants in this queue.",
    );
  });
});
