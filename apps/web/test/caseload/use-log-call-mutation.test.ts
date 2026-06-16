import { describe, expect, it, vi } from "vitest";

import {
  submitLogCall,
  type LogCallInput,
} from "../../app/caseload/_lib/useLogCallMutation";
import type { FetchLike } from "../../app/caseload/_lib/send-mutation";

const VALID_INPUT: LogCallInput = {
  status: "Completed",
  type: "Check In",
  serviceDate: "2026-05-24",
  summary: "spoke with participant about housing",
};

function jsonResponse(status: number, body: unknown, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function successBody() {
  return {
    caseNoteId: "stub_abc",
    participantId: "p1",
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
      participantId: "p1",
      score: null,
      tier: null,
      factors: [],
      previousScore: null,
      previousTier: null,
    },
    dataIssues: ["schema_gap_no_case_note_write_target"],
  };
}

describe("submitLogCall — request shaping", () => {
  it("POSTs to /api/v1/participants/:id/calls with the caller-supplied Idempotency-Key and JSON body", async () => {
    const fetchImpl: FetchLike = vi.fn(async () => jsonResponse(201, successBody()));
    const out = await submitLogCall(fetchImpl, "p1", "key-from-parent", VALID_INPUT);

    expect(out.outcome).toBe("success");
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/v1/participants/p1/calls",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          "Idempotency-Key": "key-from-parent",
        }),
        body: JSON.stringify(VALID_INPUT),
        cache: "no-store",
        credentials: "same-origin",
      }),
    );
  });

  it("encodes the participantId in the path (defensive against unusual chars)", async () => {
    const fetchImpl: FetchLike = vi.fn(async () => jsonResponse(201, successBody()));
    await submitLogCall(fetchImpl, "a/b c", "k", VALID_INPUT);
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/v1/participants/a%2Fb%20c/calls",
      expect.any(Object),
    );
  });

  it("omits `summary` from the body when undefined", async () => {
    const fetchImpl: FetchLike = vi.fn(async () => jsonResponse(201, successBody()));
    await submitLogCall(fetchImpl, "p1", "k", {
      status: "Attempted",
      type: "Check In",
      serviceDate: "2026-05-24",
    });
    const init = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as RequestInit;
    const sent = JSON.parse(init.body as string);
    expect(sent).toEqual({
      status: "Attempted",
      type: "Check In",
      serviceDate: "2026-05-24",
    });
    expect(sent).not.toHaveProperty("summary");
  });

  it("omits `summary` from the body when empty string", async () => {
    const fetchImpl: FetchLike = vi.fn(async () => jsonResponse(201, successBody()));
    await submitLogCall(fetchImpl, "p1", "k", {
      status: "Attempted",
      type: "Check In",
      serviceDate: "2026-05-24",
      summary: "",
    });
    const init = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as RequestInit;
    const sent = JSON.parse(init.body as string);
    expect(sent).not.toHaveProperty("summary");
  });

  it("returns parsed LogCallResponseBody on 2xx for P1F-05 reconciliation", async () => {
    const body = successBody();
    const fetchImpl: FetchLike = async () => jsonResponse(201, body);
    const out = await submitLogCall(fetchImpl, "p1", "k", VALID_INPUT);
    expect(out.outcome).toBe("success");
    if (out.outcome === "success") {
      expect(out.body).toEqual(body);
    }
  });

  it("propagates X-Trace-Id from the 2xx response (P1F-05 — matches server-side Pattern B audit row)", async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse(201, successBody(), { "X-Trace-Id": "trace-from-bff" });
    const out = await submitLogCall(fetchImpl, "p1", "k", VALID_INPUT);
    expect(out.outcome).toBe("success");
    if (out.outcome === "success") {
      expect(out.traceId).toBe("trace-from-bff");
    }
  });
});

describe("submitLogCall — error code mappings (API §9.4)", () => {
  it("propagates SUMMARY_REQUIRED_FOR_COMPLETED with rule + min/actualLength", async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse(422, {
        code: "SUMMARY_REQUIRED_FOR_COMPLETED",
        message: "Summary required.",
        traceId: "t-vr18",
        details: { field: "summary", rule: "VR-18", minLength: 10, actualLength: 3 },
      });
    const out = await submitLogCall(fetchImpl, "p1", "k", VALID_INPUT);
    expect(out.outcome).toBe("failure");
    if (out.outcome === "failure") {
      expect(out.failure.code).toBe("SUMMARY_REQUIRED_FOR_COMPLETED");
      expect(out.failure.rule).toBe("VR-18");
      expect(out.failure.minLength).toBe(10);
      expect(out.failure.actualLength).toBe(3);
    }
  });

  it("propagates NOT_IN_OWN_CASELOAD (403) for Specialists acting outside their caseload", async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse(403, {
        code: "NOT_IN_OWN_CASELOAD",
        message: "The requested participant is not in your caseload.",
        traceId: "t-403",
      });
    const out = await submitLogCall(fetchImpl, "p1", "k", VALID_INPUT);
    expect(out.outcome).toBe("failure");
    if (out.outcome === "failure") {
      expect(out.failure.code).toBe("NOT_IN_OWN_CASELOAD");
    }
  });

  it("propagates RESOURCE_NOT_FOUND (404) when the participant id is unresolvable", async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse(404, {
        code: "RESOURCE_NOT_FOUND",
        message: "Participant not found.",
        traceId: "t-404",
      });
    const out = await submitLogCall(fetchImpl, "p1", "k", VALID_INPUT);
    expect(out.outcome).toBe("failure");
    if (out.outcome === "failure") {
      expect(out.failure.code).toBe("RESOURCE_NOT_FOUND");
    }
  });

  it("propagates NETWORK_ERROR when fetch throws (offline)", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("offline");
    };
    const out = await submitLogCall(fetchImpl, "p1", "k", VALID_INPUT);
    expect(out.outcome).toBe("failure");
    if (out.outcome === "failure") {
      expect(out.failure.code).toBe("NETWORK_ERROR");
    }
  });

  it("reuses the same Idempotency-Key across in-sheet retries (Pattern D, key-at-open)", async () => {
    // First call → transient 503; second call (the in-sheet retry) → 201.
    // The parent (CaseloadView) reuses the same key both times.
    let call = 0;
    const fetchImpl: FetchLike = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return jsonResponse(503, {
          code: "SF_UPSTREAM_UNAVAILABLE",
          message: "x",
        });
      }
      return jsonResponse(201, successBody());
    });
    const SAME_KEY = "in-sheet-key";
    const first = await submitLogCall(fetchImpl, "p1", SAME_KEY, VALID_INPUT);
    const second = await submitLogCall(fetchImpl, "p1", SAME_KEY, VALID_INPUT);
    expect(first.outcome).toBe("failure");
    expect(second.outcome).toBe("success");
    const calls = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls;
    expect((calls[0]?.[1] as RequestInit).headers).toMatchObject({
      "Idempotency-Key": SAME_KEY,
    });
    expect((calls[1]?.[1] as RequestInit).headers).toMatchObject({
      "Idempotency-Key": SAME_KEY,
    });
  });
});
