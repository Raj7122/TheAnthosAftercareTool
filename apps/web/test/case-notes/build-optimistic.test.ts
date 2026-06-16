import { describe, expect, it } from "vitest";

import { buildOptimisticCaseNote } from "../../app/_lib/case-notes/build-optimistic";

describe("buildOptimisticCaseNote", () => {
  it("snapshots all user-input fields onto the optimistic record", () => {
    const now = () => new Date("2026-05-24T18:30:00.000Z");
    const record = buildOptimisticCaseNote({
      participantId: "a015g00000P1aaaQAO",
      optimisticId: "optimistic:abc",
      callStatus: "Completed",
      type: "Stability Meeting",
      serviceDate: "2026-05-24",
      summary: "spoke with participant — housing application submitted",
      now,
    });
    expect(record).toEqual({
      optimisticId: "optimistic:abc",
      participantId: "a015g00000P1aaaQAO",
      callStatus: "Completed",
      type: "Stability Meeting",
      serviceDate: "2026-05-24",
      summary: "spoke with participant — housing application submitted",
      optimisticAt: "2026-05-24T18:30:00.000Z",
    });
  });

  it("threads `null` summary through (Pattern A: empty summary is a real local state)", () => {
    const record = buildOptimisticCaseNote({
      participantId: "p1",
      optimisticId: "o1",
      callStatus: "Attempted",
      type: "Check In",
      serviceDate: "2026-05-24",
      summary: null,
      now: () => new Date("2026-05-24T00:00:00.000Z"),
    });
    expect(record.summary).toBeNull();
  });

  it("uses the injected clock for `optimisticAt` so tests are deterministic", () => {
    const fixed = new Date("2025-01-01T00:00:00.000Z");
    const record = buildOptimisticCaseNote({
      participantId: "p1",
      optimisticId: "o1",
      callStatus: "Attempted",
      type: "Check In",
      serviceDate: "2025-01-01",
      summary: null,
      now: () => fixed,
    });
    expect(record.optimisticAt).toBe("2025-01-01T00:00:00.000Z");
  });
});
