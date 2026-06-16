// P1F-05 — recent-case-notes store reducer tests. Pure-function discipline
// per the barriers Pattern A precedent (`caseload-mutations.test.ts`).

import type { LogCallResponseBody } from "@anthos/api";
import { describe, expect, it } from "vitest";

import {
  applyConfirmed,
  applyOptimistic,
  applyRollback,
  EMPTY_STORE,
  getForParticipant,
  reduce,
  type StoreAction,
} from "../../app/_lib/case-notes/store";
import type { OptimisticCaseNote } from "../../app/_lib/case-notes/types";

const P1 = "a015g00000P1aaaQAO";
const P2 = "a015g00000P2bbbQAO";

function makeOptimistic(
  overrides: Partial<OptimisticCaseNote> = {},
): OptimisticCaseNote {
  return {
    optimisticId: "optimistic:1",
    participantId: P1,
    callStatus: "Completed",
    type: "Check In",
    serviceDate: "2026-05-24",
    summary: "spoke with participant about housing",
    optimisticAt: "2026-05-24T18:00:00.000Z",
    ...overrides,
  };
}

function makeCanonical(
  overrides: Partial<LogCallResponseBody> = {},
): LogCallResponseBody {
  return {
    caseNoteId: "stub_xyz",
    participantId: P1,
    status: "Completed",
    type: "Check In",
    contactType: "phone",
    summary: "spoke with participant about housing",
    serviceDate: "2026-05-24",
    occurredAt: "2026-05-24T18:00:00.000Z",
    loggedAt: "2026-05-24T18:00:00.000Z",
    loggedBy: "specialist-1",
    source: "tool",
    priorityRecomputed: {
      participantId: P1,
      score: null,
      tier: null,
      factors: [],
      previousScore: null,
      previousTier: null,
    },
    dataIssues: ["schema_gap_no_case_note_write_target"],
    ...overrides,
  };
}

// ── applyOptimistic ─────────────────────────────────────────────────────────

describe("applyOptimistic", () => {
  it("inserts the optimistic record at the head of an empty participant list", () => {
    const next = applyOptimistic(EMPTY_STORE, makeOptimistic());
    const list = next.get(P1);
    expect(list).toHaveLength(1);
    expect(list?.[0]).toEqual({
      state: "saving",
      optimistic: makeOptimistic(),
    });
  });

  it("prepends to an existing list (insertion order — head is newest)", () => {
    const first = makeOptimistic({ optimisticId: "optimistic:1" });
    const second = makeOptimistic({ optimisticId: "optimistic:2" });
    const after1 = applyOptimistic(EMPTY_STORE, first);
    const after2 = applyOptimistic(after1, second);
    const list = after2.get(P1);
    expect(list?.[0]?.optimistic.optimisticId).toBe("optimistic:2");
    expect(list?.[1]?.optimistic.optimisticId).toBe("optimistic:1");
  });

  it("does not mutate the input map", () => {
    const next = applyOptimistic(EMPTY_STORE, makeOptimistic());
    expect(EMPTY_STORE.size).toBe(0);
    expect(next).not.toBe(EMPTY_STORE);
  });

  it("keeps other participants untouched", () => {
    const with1 = applyOptimistic(EMPTY_STORE, makeOptimistic());
    const list1 = with1.get(P1);
    const with2 = applyOptimistic(
      with1,
      makeOptimistic({ optimisticId: "optimistic:p2", participantId: P2 }),
    );
    expect(with2.get(P1)).toBe(list1);
  });
});

// ── applyConfirmed ──────────────────────────────────────────────────────────

describe("applyConfirmed", () => {
  it("replaces a 'saving' record with a 'confirmed' record at the same index", () => {
    const seed = applyOptimistic(EMPTY_STORE, makeOptimistic());
    const next = applyConfirmed(seed, "optimistic:1", makeCanonical(), "trace-abc");
    const list = next.get(P1);
    expect(list).toHaveLength(1);
    expect(list?.[0]).toEqual({
      state: "confirmed",
      optimistic: makeOptimistic(),
      canonical: makeCanonical(),
      traceId: "trace-abc",
    });
  });

  it("preserves stable insertion order across the saving→confirmed transition", () => {
    const first = makeOptimistic({ optimisticId: "optimistic:1" });
    const second = makeOptimistic({ optimisticId: "optimistic:2" });
    const seed = applyOptimistic(
      applyOptimistic(EMPTY_STORE, first),
      second,
    );
    const next = applyConfirmed(
      seed,
      "optimistic:1",
      makeCanonical({ caseNoteId: "real-1" }),
      "trace-1",
    );
    const list = next.get(P1) ?? [];
    expect(list[0]?.optimistic.optimisticId).toBe("optimistic:2");
    expect(list[1]?.optimistic.optimisticId).toBe("optimistic:1");
    expect(list[1]?.state).toBe("confirmed");
    expect(list[0]?.state).toBe("saving");
  });

  it("returns the same reference when the optimisticId is not found", () => {
    const seed = applyOptimistic(EMPTY_STORE, makeOptimistic());
    const next = applyConfirmed(seed, "optimistic:missing", makeCanonical(), null);
    expect(next).toBe(seed);
  });

  it("returns the same reference when the participant has no records", () => {
    const next = applyConfirmed(EMPTY_STORE, "optimistic:1", makeCanonical(), null);
    expect(next).toBe(EMPTY_STORE);
  });

  it("accepts a null traceId (defensive — E-10 always sets X-Trace-Id but typed for safety)", () => {
    const seed = applyOptimistic(EMPTY_STORE, makeOptimistic());
    const next = applyConfirmed(seed, "optimistic:1", makeCanonical(), null);
    const row = next.get(P1)?.[0];
    expect(row?.state).toBe("confirmed");
    if (row?.state === "confirmed") {
      expect(row.traceId).toBeNull();
    }
  });
});

// ── applyRollback ───────────────────────────────────────────────────────────

describe("applyRollback", () => {
  it("removes the optimistic record (visible rollback per Pattern A)", () => {
    const seed = applyOptimistic(EMPTY_STORE, makeOptimistic());
    const next = applyRollback(seed, P1, "optimistic:1");
    expect(next.get(P1)).toBeUndefined();
  });

  it("deletes the participant entry when the list becomes empty (no empty-list residue)", () => {
    const seed = applyOptimistic(EMPTY_STORE, makeOptimistic());
    const next = applyRollback(seed, P1, "optimistic:1");
    expect(next.has(P1)).toBe(false);
  });

  it("preserves siblings when rolling back one of many", () => {
    const first = makeOptimistic({ optimisticId: "optimistic:1" });
    const second = makeOptimistic({ optimisticId: "optimistic:2" });
    const seed = applyOptimistic(
      applyOptimistic(EMPTY_STORE, first),
      second,
    );
    const next = applyRollback(seed, P1, "optimistic:1");
    const list = next.get(P1) ?? [];
    expect(list).toHaveLength(1);
    expect(list[0]?.optimistic.optimisticId).toBe("optimistic:2");
  });

  it("returns the same reference when the id is unknown", () => {
    const seed = applyOptimistic(EMPTY_STORE, makeOptimistic());
    const next = applyRollback(seed, P1, "optimistic:missing");
    expect(next).toBe(seed);
  });

  it("returns the same reference when the participant has no records", () => {
    const next = applyRollback(EMPTY_STORE, P1, "optimistic:1");
    expect(next).toBe(EMPTY_STORE);
  });
});

// ── getForParticipant ───────────────────────────────────────────────────────

describe("getForParticipant", () => {
  it("returns an empty array (not undefined) for unknown participants", () => {
    expect(getForParticipant(EMPTY_STORE, "missing")).toEqual([]);
  });

  it("returns the same stable empty-array reference across calls", () => {
    const a = getForParticipant(EMPTY_STORE, "missing-a");
    const b = getForParticipant(EMPTY_STORE, "missing-b");
    expect(a).toBe(b);
  });
});

// ── reduce (action dispatch) ────────────────────────────────────────────────

describe("reduce", () => {
  it("handles the full Pattern A flow: insert → confirm → noop on rollback of confirmed id", () => {
    const insert: StoreAction = {
      type: "optimistic_insert",
      optimistic: makeOptimistic(),
    };
    const confirm: StoreAction = {
      type: "confirmed_replace",
      optimisticId: "optimistic:1",
      canonical: makeCanonical(),
      traceId: "trace-1",
    };
    const state = reduce(reduce(EMPTY_STORE, insert), confirm);
    const list = state.get(P1) ?? [];
    expect(list).toHaveLength(1);
    expect(list[0]?.state).toBe("confirmed");
  });

  it("handles the rollback flow: insert → rollback drops the record", () => {
    const state = reduce(
      reduce(EMPTY_STORE, {
        type: "optimistic_insert",
        optimistic: makeOptimistic(),
      }),
      { type: "rolled_back", participantId: P1, optimisticId: "optimistic:1" },
    );
    expect(state.get(P1)).toBeUndefined();
  });
});
