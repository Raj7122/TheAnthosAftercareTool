import { describe, expect, it } from "vitest";

import {
  KNOWN_QUEUE_IDS,
  orderQueueIds,
} from "../../app/caseload/_lib/queue-labels";

describe("orderQueueIds", () => {
  it("renders identical order regardless of queueCounts key insertion order (P1C-08 regression — cache-warm vs cache-cold)", () => {
    const insertionOrder = {
      caseload_overview: 62,
      due_soon: 12,
      never_successfully_contacted: 4,
      check_ins_due_this_month: 18,
    };
    const reversed = {
      check_ins_due_this_month: 18,
      never_successfully_contacted: 4,
      due_soon: 12,
      caseload_overview: 62,
    };

    expect(orderQueueIds(insertionOrder)).toEqual(orderQueueIds(reversed));
  });

  it("orders the four BR-22 queues in canonical KNOWN_QUEUE_IDS sequence", () => {
    const queueCounts = {
      check_ins_due_this_month: 18,
      never_successfully_contacted: 4,
      due_soon: 12,
      caseload_overview: 62,
    };

    expect(orderQueueIds(queueCounts)).toEqual([
      "caseload_overview",
      "due_soon",
      "never_successfully_contacted",
      "check_ins_due_this_month",
    ]);
  });

  it("emits only the queues present in queueCounts, in canonical order", () => {
    const subset = {
      check_ins_due_this_month: 18,
      due_soon: 12,
    };

    expect(orderQueueIds(subset)).toEqual([
      "due_soon",
      "check_ins_due_this_month",
    ]);
  });

  it("appends BR-22 unknown ids after the known set, preserving their insertion order", () => {
    const withUnknown = {
      future_queue_b: 7,
      caseload_overview: 62,
      future_queue_a: 3,
      due_soon: 12,
    };

    expect(orderQueueIds(withUnknown)).toEqual([
      "caseload_overview",
      "due_soon",
      "future_queue_b",
      "future_queue_a",
    ]);
  });

  it("returns an empty list for an empty queueCounts map", () => {
    expect(orderQueueIds({})).toEqual([]);
  });
});

describe("KNOWN_QUEUE_IDS", () => {
  it("locks the BR-22 queue order against accidental reordering", () => {
    expect(KNOWN_QUEUE_IDS).toEqual([
      "caseload_overview",
      "due_soon",
      "never_successfully_contacted",
      "check_ins_due_this_month",
    ]);
  });
});
