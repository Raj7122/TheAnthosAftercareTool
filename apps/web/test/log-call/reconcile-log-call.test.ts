// P1F-05 — Pattern A reconcile loop tests. Drives `reconcileLogCall` (the
// pure orchestrator behind `useLogCallReconciler`) with stubbed dispatch +
// mutation deps, exercising every reconciliation outcome the ticket calls
// out plus the in-flight retry / key-reuse guarantees.

import type { LogCallResponseBody } from "@anthos/api";
import { describe, expect, it, vi } from "vitest";

import {
  reconcileLogCall,
  type ReconcileDispatch,
  type ReconcileLogCallDeps,
} from "../../app/_lib/log-call/reconcile-log-call";
import type { LogCallInput } from "../../app/caseload/_lib/useLogCallMutation";

const P1 = "a015g00000P1aaaQAO";

const VALID_INPUT: LogCallInput = {
  status: "Completed",
  type: "Check In",
  serviceDate: "2026-05-24",
  summary: "spoke with participant about housing",
};

function canonical(
  overrides: Partial<LogCallResponseBody> = {},
): LogCallResponseBody {
  return {
    caseNoteId: "stub_abc",
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

function makeDispatch(): ReconcileDispatch & {
  readonly calls: ReadonlyArray<unknown>;
} {
  const calls: unknown[] = [];
  return {
    insertOptimistic: vi.fn((optimistic) =>
      calls.push({ type: "insertOptimistic", optimistic }),
    ),
    replaceWithCanonical: vi.fn((optimisticId, canonical, traceId) =>
      calls.push({
        type: "replaceWithCanonical",
        optimisticId,
        canonical,
        traceId,
      }),
    ),
    rollback: vi.fn((participantId, optimisticId) =>
      calls.push({ type: "rollback", participantId, optimisticId }),
    ),
    get calls() {
      return calls;
    },
  };
}

// Per-test overrides exclude `dispatch` so the typed harness (with `calls`)
// flows through unchanged. Tests that need to inject a bespoke dispatch
// build the deps record by hand instead.
type DepsOverrides = Partial<Omit<ReconcileLogCallDeps, "dispatch">>;

function makeDeps(
  overrides: DepsOverrides = {},
): ReconcileLogCallDeps & {
  readonly dispatch: ReturnType<typeof makeDispatch>;
} {
  const dispatch = makeDispatch();
  const defaultLogCall: ReconcileLogCallDeps["logCall"] = vi.fn(async () => ({
    outcome: "success" as const,
    body: canonical(),
    traceId: "trace-1",
  }));
  return {
    dispatch,
    logCall: defaultLogCall,
    sleep: vi.fn(async () => {}),
    now: () => new Date("2026-05-24T18:00:00.000Z"),
    newOptimisticId: () => "optimistic:test-1",
    ...overrides,
  };
}

// ── SUCCESS (Pattern A canonical replacement) ───────────────────────────────

describe("reconcileLogCall — success path", () => {
  it("inserts the optimistic record, calls the BFF, and replaces with the canonical record", async () => {
    const deps = makeDeps();
    const out = await reconcileLogCall(deps, P1, "key-1", VALID_INPUT);
    expect(out).toBeNull();
    expect(deps.dispatch.calls).toEqual([
      {
        type: "insertOptimistic",
        optimistic: {
          optimisticId: "optimistic:test-1",
          participantId: P1,
          callStatus: "Completed",
          type: "Check In",
          serviceDate: "2026-05-24",
          summary: "spoke with participant about housing",
          optimisticAt: "2026-05-24T18:00:00.000Z",
        },
      },
      {
        type: "replaceWithCanonical",
        optimisticId: "optimistic:test-1",
        canonical: canonical(),
        traceId: "trace-1",
      },
    ]);
  });

  it("propagates trace_id from the 2xx response (matches server-side Pattern B audit row)", async () => {
    const deps = makeDeps({
      logCall: vi.fn(async () => ({
        outcome: "success" as const,
        body: canonical(),
        traceId: "trace-from-bff",
      })),
    });
    await reconcileLogCall(deps, P1, "key-2", VALID_INPUT);
    const replace = deps.dispatch.calls.find(
      (c): c is { type: "replaceWithCanonical"; traceId: string | null } =>
        typeof c === "object" &&
        c !== null &&
        (c as { type: string }).type === "replaceWithCanonical",
    );
    expect(replace?.traceId).toBe("trace-from-bff");
  });

  it("normalizes empty summary to `null` on the optimistic record (no '' in store)", async () => {
    const deps = makeDeps();
    await reconcileLogCall(deps, P1, "key-3", {
      status: "Attempted",
      type: "Check In",
      serviceDate: "2026-05-24",
      summary: "",
    });
    const insert = deps.dispatch.calls[0] as {
      type: string;
      optimistic: { summary: string | null };
    };
    expect(insert.optimistic.summary).toBeNull();
  });

  it("does NOT call rollback on success", async () => {
    const deps = makeDeps();
    await reconcileLogCall(deps, P1, "key-4", VALID_INPUT);
    expect(deps.dispatch.rollback).not.toHaveBeenCalled();
  });
});

// ── 4xx TERMINAL ROLLBACK ───────────────────────────────────────────────────

describe("reconcileLogCall — 4xx terminal rollback", () => {
  it("rolls back the optimistic record on VALIDATION_FAILED (no retry)", async () => {
    const logCall = vi.fn(async () => ({
      outcome: "failure" as const,
      failure: {
        code: "VALIDATION_FAILED",
        message: "x",
        traceId: "t",
        field: "summary",
        reason: "too_short",
      },
    }));
    const deps = makeDeps({ logCall });
    const out = await reconcileLogCall(deps, P1, "key-1", VALID_INPUT);
    expect(out?.code).toBe("VALIDATION_FAILED");
    expect(logCall).toHaveBeenCalledTimes(1);
    expect(deps.dispatch.rollback).toHaveBeenCalledWith(
      P1,
      "optimistic:test-1",
    );
  });

  it("rolls back on SUMMARY_REQUIRED_FOR_COMPLETED (VR-18) without retrying", async () => {
    const logCall = vi.fn(async () => ({
      outcome: "failure" as const,
      failure: {
        code: "SUMMARY_REQUIRED_FOR_COMPLETED",
        message: "x",
        traceId: "t",
        field: "summary",
        reason: null,
        rule: "VR-18",
        minLength: 10,
        actualLength: 3,
      },
    }));
    const deps = makeDeps({ logCall });
    const out = await reconcileLogCall(deps, P1, "k", VALID_INPUT);
    expect(out?.code).toBe("SUMMARY_REQUIRED_FOR_COMPLETED");
    expect(out?.rule).toBe("VR-18");
    expect(logCall).toHaveBeenCalledTimes(1);
    expect(deps.dispatch.rollback).toHaveBeenCalled();
  });

  it("rolls back on NOT_IN_OWN_CASELOAD (403)", async () => {
    const logCall = vi.fn(async () => ({
      outcome: "failure" as const,
      failure: {
        code: "NOT_IN_OWN_CASELOAD",
        message: "x",
        traceId: "t",
        field: null,
        reason: null,
      },
    }));
    const deps = makeDeps({ logCall });
    const out = await reconcileLogCall(deps, P1, "k", VALID_INPUT);
    expect(out?.code).toBe("NOT_IN_OWN_CASELOAD");
    expect(deps.dispatch.rollback).toHaveBeenCalledTimes(1);
  });

  it("does not call replaceWithCanonical on terminal failure", async () => {
    const logCall = vi.fn(async () => ({
      outcome: "failure" as const,
      failure: {
        code: "VALIDATION_FAILED",
        message: "x",
        traceId: "t",
        field: null,
        reason: null,
      },
    }));
    const deps = makeDeps({ logCall });
    await reconcileLogCall(deps, P1, "k", VALID_INPUT);
    expect(deps.dispatch.replaceWithCanonical).not.toHaveBeenCalled();
  });
});

// ── 5xx RETRY + ROLLBACK ────────────────────────────────────────────────────

describe("reconcileLogCall — 5xx retry budget", () => {
  it("retries once on SF_UPSTREAM_UNAVAILABLE, succeeds on the retry, and replaces with canonical", async () => {
    let call = 0;
    const logCall = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return {
          outcome: "failure" as const,
          failure: {
            code: "SF_UPSTREAM_UNAVAILABLE",
            message: "x",
            traceId: "t",
            field: null,
            reason: null,
          },
        };
      }
      return {
        outcome: "success" as const,
        body: canonical(),
        traceId: "trace-retry",
      };
    });
    const sleep = vi.fn(async () => {});
    const deps = makeDeps({ logCall, sleep });
    const out = await reconcileLogCall(deps, P1, "key-retry", VALID_INPUT);
    expect(out).toBeNull();
    expect(logCall).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(deps.dispatch.replaceWithCanonical).toHaveBeenCalledWith(
      "optimistic:test-1",
      canonical(),
      "trace-retry",
    );
    expect(deps.dispatch.rollback).not.toHaveBeenCalled();
  });

  it("rolls back after retry budget exhausts (2 attempts, then terminal)", async () => {
    const logCall = vi.fn(async () => ({
      outcome: "failure" as const,
      failure: {
        code: "SF_UPSTREAM_UNAVAILABLE",
        message: "x",
        traceId: "t",
        field: null,
        reason: null,
      },
    }));
    const sleep = vi.fn(async () => {});
    const deps = makeDeps({ logCall, sleep });
    const out = await reconcileLogCall(deps, P1, "k", VALID_INPUT);
    expect(out?.code).toBe("SF_UPSTREAM_UNAVAILABLE");
    expect(logCall).toHaveBeenCalledTimes(2); // 1 initial + 1 retry
    expect(sleep).toHaveBeenCalledTimes(1); // backoff before the retry only
    expect(deps.dispatch.rollback).toHaveBeenCalledTimes(1);
  });

  it("rolls back on INTERNAL_ERROR (500) after retry exhausts", async () => {
    const logCall = vi.fn(async () => ({
      outcome: "failure" as const,
      failure: {
        code: "INTERNAL_ERROR",
        message: "x",
        traceId: "t",
        field: null,
        reason: null,
      },
    }));
    const deps = makeDeps({ logCall });
    const out = await reconcileLogCall(deps, P1, "k", VALID_INPUT);
    expect(out?.code).toBe("INTERNAL_ERROR");
    expect(logCall).toHaveBeenCalledTimes(2);
    expect(deps.dispatch.rollback).toHaveBeenCalled();
  });

  it("rolls back immediately on NETWORK_ERROR (no retry — Pattern C territory deferred)", async () => {
    const logCall = vi.fn(async () => ({
      outcome: "failure" as const,
      failure: {
        code: "NETWORK_ERROR",
        message: "offline",
        traceId: null,
        field: null,
        reason: null,
      },
    }));
    const deps = makeDeps({ logCall });
    const out = await reconcileLogCall(deps, P1, "k", VALID_INPUT);
    expect(out?.code).toBe("NETWORK_ERROR");
    expect(logCall).toHaveBeenCalledTimes(1);
    expect(deps.dispatch.rollback).toHaveBeenCalled();
  });
});

// ── IDEMPOTENCY KEY REUSE ───────────────────────────────────────────────────

describe("reconcileLogCall — Pattern D key reuse across retries", () => {
  it("passes the same idempotency key to the underlying mutation on every attempt", async () => {
    let call = 0;
    const logCall = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return {
          outcome: "failure" as const,
          failure: {
            code: "SF_UPSTREAM_UNAVAILABLE",
            message: "x",
            traceId: "t",
            field: null,
            reason: null,
          },
        };
      }
      return {
        outcome: "success" as const,
        body: canonical(),
        traceId: "trace-1",
      };
    });
    const deps = makeDeps({ logCall });
    await reconcileLogCall(deps, P1, "stable-key", VALID_INPUT);
    expect(logCall).toHaveBeenNthCalledWith(1, P1, "stable-key", VALID_INPUT);
    expect(logCall).toHaveBeenNthCalledWith(2, P1, "stable-key", VALID_INPUT);
  });
});

// ── PATTERN A ANTI-PATTERN GUARDS ───────────────────────────────────────────

describe("reconcileLogCall — Pattern A anti-pattern guards", () => {
  it("emits the dispatch sequence in the right order: insert BEFORE network call (UI updates now)", async () => {
    const order: string[] = [];
    const dispatch: ReconcileDispatch = {
      insertOptimistic: () => order.push("insert"),
      replaceWithCanonical: () => order.push("replace"),
      rollback: () => order.push("rollback"),
    };
    const logCall: ReconcileLogCallDeps["logCall"] = vi.fn(async () => {
      order.push("network");
      return {
        outcome: "success" as const,
        body: canonical(),
        traceId: "t",
      };
    });
    const deps: ReconcileLogCallDeps = {
      dispatch,
      logCall,
      sleep: async () => {},
      now: () => new Date("2026-05-24T18:00:00.000Z"),
      newOptimisticId: () => "optimistic:test-1",
    };
    await reconcileLogCall(deps, P1, "k", VALID_INPUT);
    expect(order).toEqual(["insert", "network", "replace"]);
  });

  it("does NOT replaceWithCanonical before the 2xx arrives (no 'saved' before BFF returns)", async () => {
    const events: string[] = [];
    const dispatch: ReconcileDispatch = {
      insertOptimistic: () => events.push("insert"),
      replaceWithCanonical: () => events.push("replace"),
      rollback: () => events.push("rollback"),
    };
    // Delay the network call to simulate in-flight; replace must not fire
    // until after the success result is returned.
    const logCall: ReconcileLogCallDeps["logCall"] = () =>
      new Promise((resolve) =>
        setTimeout(() => {
          events.push("network-resolved");
          resolve({
            outcome: "success" as const,
            body: canonical(),
            traceId: "t",
          });
        }, 5),
      );
    const deps: ReconcileLogCallDeps = {
      dispatch,
      logCall,
      sleep: async () => {},
      now: () => new Date("2026-05-24T18:00:00.000Z"),
      newOptimisticId: () => "optimistic:test-1",
    };
    await reconcileLogCall(deps, P1, "k", VALID_INPUT);
    // 'replace' MUST come after 'network-resolved' — never before.
    const replaceIdx = events.indexOf("replace");
    const networkIdx = events.indexOf("network-resolved");
    expect(replaceIdx).toBeGreaterThan(networkIdx);
  });

  it("rolls back visibly (dispatch.rollback) — does not silently drop the failure", async () => {
    const logCall = vi.fn(async () => ({
      outcome: "failure" as const,
      failure: {
        code: "VALIDATION_FAILED",
        message: "x",
        traceId: "t",
        field: null,
        reason: null,
      },
    }));
    const deps = makeDeps({ logCall });
    await reconcileLogCall(deps, P1, "k", VALID_INPUT);
    expect(deps.dispatch.rollback).toHaveBeenCalled();
  });
});
