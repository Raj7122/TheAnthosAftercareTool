// P1F-05 integration test — drives the Pattern A loop through the real
// `submitLogCall` primitive against a mocked `fetch` so the end-to-end shape
// (request body, Idempotency-Key reuse on retry, X-Trace-Id propagation,
// canonical response → store transition) is exercised in one path. The
// `reconcile-log-call.test.ts` unit tests stub the mutation; this one wires
// it for real.

import type { LogCallResponseBody } from "@anthos/api";
import { describe, expect, it, vi } from "vitest";

import { reconcileLogCall } from "../../app/_lib/log-call/reconcile-log-call";
import type { ReconcileDispatch } from "../../app/_lib/log-call/reconcile-log-call";
import {
  EMPTY_STORE,
  reduce,
} from "../../app/_lib/case-notes/store";
import type {
  LocalCaseNotesByParticipant,
  OptimisticCaseNote,
} from "../../app/_lib/case-notes/types";
import type { FetchLike } from "../../app/caseload/_lib/send-mutation";
import {
  submitLogCall,
  type LogCallInput,
  type LogCallResult,
} from "../../app/caseload/_lib/useLogCallMutation";

const P1 = "a015g00000P1aaaQAO";

const INPUT: LogCallInput = {
  status: "Completed",
  type: "Check In",
  serviceDate: "2026-05-24",
  summary: "spoke with participant about housing",
};

function jsonResponse(
  status: number,
  body: unknown,
  headers: HeadersInit = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function canonical(): LogCallResponseBody {
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
  };
}

// Build a dispatch that drives the real store reducer in place — gives the
// integration test a real read-back of state transitions rather than just
// the dispatch call log.
function makeStoreHarness() {
  let state: LocalCaseNotesByParticipant = EMPTY_STORE;
  const inserts: OptimisticCaseNote[] = [];
  const dispatch: ReconcileDispatch = {
    insertOptimistic: (optimistic) => {
      inserts.push(optimistic);
      state = reduce(state, { type: "optimistic_insert", optimistic });
    },
    replaceWithCanonical: (optimisticId, canon, traceId) => {
      state = reduce(state, {
        type: "confirmed_replace",
        optimisticId,
        canonical: canon,
        traceId,
      });
    },
    rollback: (participantId, optimisticId) => {
      state = reduce(state, {
        type: "rolled_back",
        participantId,
        optimisticId,
      });
    },
  };
  return {
    dispatch,
    get state() {
      return state;
    },
    inserts,
  };
}

describe("reconcileLogCall + real submitLogCall — end-to-end", () => {
  it("optimistic → fetch → confirmed (2xx) leaves the store with a single 'confirmed' record carrying trace_id", async () => {
    const fetchImpl: FetchLike = vi.fn(async () =>
      jsonResponse(201, canonical(), { "X-Trace-Id": "trace-integration" }),
    );
    const harness = makeStoreHarness();
    const logCall = (
      participantId: string,
      idempotencyKey: string,
      input: LogCallInput,
    ): Promise<LogCallResult> =>
      submitLogCall(fetchImpl, participantId, idempotencyKey, input);

    const out = await reconcileLogCall(
      {
        dispatch: harness.dispatch,
        logCall,
        sleep: async () => {},
        now: () => new Date("2026-05-24T18:00:00.000Z"),
        newOptimisticId: () => "optimistic:e2e-1",
      },
      P1,
      "ik-e2e",
      INPUT,
    );

    expect(out).toBeNull();
    const list = harness.state.get(P1) ?? [];
    expect(list).toHaveLength(1);
    const row = list[0];
    expect(row?.state).toBe("confirmed");
    if (row?.state === "confirmed") {
      expect(row.canonical.caseNoteId).toBe("stub_xyz");
      expect(row.traceId).toBe("trace-integration");
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reuses the Idempotency-Key across a 503 → 2xx retry (Pattern D dedupe contract)", async () => {
    let call = 0;
    const fetchImpl: FetchLike = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return jsonResponse(
          503,
          { code: "SF_UPSTREAM_UNAVAILABLE", message: "transient" },
          { "X-Trace-Id": "trace-503" },
        );
      }
      return jsonResponse(201, canonical(), { "X-Trace-Id": "trace-retry" });
    });
    const harness = makeStoreHarness();
    const out = await reconcileLogCall(
      {
        dispatch: harness.dispatch,
        logCall: (pid, ik, input) => submitLogCall(fetchImpl, pid, ik, input),
        sleep: async () => {},
        now: () => new Date(),
        newOptimisticId: () => "optimistic:retry",
      },
      P1,
      "ik-stable",
      INPUT,
    );

    expect(out).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const calls = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls;
    expect((calls[0]?.[1] as RequestInit).headers).toMatchObject({
      "Idempotency-Key": "ik-stable",
    });
    expect((calls[1]?.[1] as RequestInit).headers).toMatchObject({
      "Idempotency-Key": "ik-stable",
    });
    const list = harness.state.get(P1) ?? [];
    expect(list[0]?.state).toBe("confirmed");
  });

  it("rolls back on a 4xx terminal envelope (VR-18) — store ends empty for the participant", async () => {
    const fetchImpl: FetchLike = vi.fn(async () =>
      jsonResponse(
        422,
        {
          code: "SUMMARY_REQUIRED_FOR_COMPLETED",
          message: "Summary required.",
          traceId: "trace-vr18",
          details: {
            field: "summary",
            rule: "VR-18",
            minLength: 10,
            actualLength: 3,
          },
        },
        { "X-Trace-Id": "trace-vr18" },
      ),
    );
    const harness = makeStoreHarness();
    const out = await reconcileLogCall(
      {
        dispatch: harness.dispatch,
        logCall: (pid, ik, input) => submitLogCall(fetchImpl, pid, ik, input),
        sleep: async () => {},
        now: () => new Date(),
        newOptimisticId: () => "optimistic:vr18",
      },
      P1,
      "ik-4xx",
      INPUT,
    );
    expect(out?.code).toBe("SUMMARY_REQUIRED_FOR_COMPLETED");
    expect(out?.rule).toBe("VR-18");
    // Visible rollback — record removed from store, participant entry gone.
    expect(harness.state.has(P1)).toBe(false);
    // Single attempt only — 4xx is terminal.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rolls back after 5xx retry exhaustion (2 attempts, then terminal failure surfaced)", async () => {
    const fetchImpl: FetchLike = vi.fn(async () =>
      jsonResponse(
        503,
        { code: "SF_UPSTREAM_UNAVAILABLE", message: "still down" },
        { "X-Trace-Id": "trace-503" },
      ),
    );
    const harness = makeStoreHarness();
    const out = await reconcileLogCall(
      {
        dispatch: harness.dispatch,
        logCall: (pid, ik, input) => submitLogCall(fetchImpl, pid, ik, input),
        sleep: async () => {},
        now: () => new Date(),
        newOptimisticId: () => "optimistic:exhaust",
      },
      P1,
      "ik-5xx",
      INPUT,
    );
    expect(out?.code).toBe("SF_UPSTREAM_UNAVAILABLE");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(harness.state.has(P1)).toBe(false);
  });
});
