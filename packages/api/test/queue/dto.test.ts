// Pure-function unit tests for the queue DTO helpers (P3C-05). No DB, no
// session — exercises the two derivation rules that the spec calls out by
// name (§7.5.1 notes) plus the body assembler.

import type {
  OfflineQueueRow,
  PendingQueueResult,
  StatusCounts,
} from "@anthos/persistence";
import { describe, expect, it } from "vitest";

import {
  buildQueuePendingBody,
  derivePayloadPreview,
  deriveSuggestedResolution,
  RESOLUTION_OPTIONS,
} from "../../src/queue/dto.js";

const SPECIALIST_ID = "0058K00000XYZAbQAO";

function row(overrides: Partial<OfflineQueueRow> = {}): OfflineQueueRow {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    specialistId: SPECIALIST_ID,
    participantId: "a015g00000ABCDxQAO",
    actionType: "call.logged",
    status: "review_required_reassigned",
    createdAt: new Date("2026-05-09T10:23:00Z"),
    lastAttemptAt: new Date("2026-05-09T14:35:00Z"),
    retryCount: 2,
    errorDetails: {
      sfErrorCode: "INVALID_CROSS_REFERENCE_KEY",
      message: "Participant P was reassigned.",
    },
    payload: { status: "Completed", summary: "Brief check-in call" },
    ...overrides,
  };
}

function emptyCounts(): StatusCounts {
  return {
    pending_sync: 0,
    in_flight: 0,
    review_required_reassigned: 0,
    review_required_terminated: 0,
    failed_max_retries: 0,
  };
}

describe("derivePayloadPreview", () => {
  it("emits an empty object for null / non-object payloads", () => {
    expect(derivePayloadPreview(null)).toEqual({});
    expect(derivePayloadPreview(undefined)).toEqual({});
    expect(derivePayloadPreview("just a string")).toEqual({});
    expect(derivePayloadPreview(42)).toEqual({});
  });

  it("passes through allow-listed scalars (status, outcome)", () => {
    const preview = derivePayloadPreview({
      status: "Completed",
      outcome: "reached",
    });
    expect(preview).toEqual({ status: "Completed", outcome: "reached" });
  });

  it("drops fields outside the allow-list (no PII leakage)", () => {
    const preview = derivePayloadPreview({
      status: "Completed",
      participantName: "Marie Alcis",
      phoneNumber: "+15551234567",
      email: "marie@example.org",
      notes: "PHI-suspect free text",
    });
    expect(preview).toEqual({ status: "Completed" });
    expect(preview).not.toHaveProperty("participantName");
    expect(preview).not.toHaveProperty("phoneNumber");
    expect(preview).not.toHaveProperty("email");
  });

  it("ignores non-string values on allow-listed keys", () => {
    expect(derivePayloadPreview({ status: 42, outcome: null })).toEqual({});
    expect(derivePayloadPreview({ status: "" })).toEqual({});
  });

  it("emits a 60-char ellipsized snippet from summary / note / body (first non-empty)", () => {
    const longText = "x".repeat(120);
    const fromSummary = derivePayloadPreview({ summary: longText });
    expect(fromSummary.snippet).toHaveLength(60);
    expect(fromSummary.snippet).toMatch(/…$/);

    // `summary` wins over `note` when both are present.
    expect(
      derivePayloadPreview({ summary: "S", note: "N", body: "B" }),
    ).toEqual({ snippet: "S" });

    // Falls through to `note` when `summary` is missing / empty.
    expect(derivePayloadPreview({ note: "N", body: "B" })).toEqual({
      snippet: "N",
    });

    // Falls through to `body` when both `summary` and `note` are absent.
    expect(derivePayloadPreview({ body: "B" })).toEqual({ snippet: "B" });
  });

  it("does not truncate snippets at or under the limit", () => {
    const exactly60 = "x".repeat(60);
    expect(derivePayloadPreview({ summary: exactly60 })).toEqual({
      snippet: exactly60,
    });
  });
});

describe("deriveSuggestedResolution", () => {
  it.each([
    ["UNABLE_TO_LOCK_ROW", "REASSIGN_RETRY"],
    ["INVALID_CROSS_REFERENCE_KEY", "ESCALATE_TO_SUPERVISOR"],
  ])("maps %s → %s per ERD §6.3", (code, expected) => {
    expect(deriveSuggestedResolution(code)).toBe(expected);
  });

  // ERD §6.3 L651 leaves the ENTITY_IS_DELETED default open ("DISCARD or
  // ESCALATE_TO_SUPERVISOR per OBQ-3"). Our stub defaults to DISCARD; this
  // test pins the stub so an inadvertent flip is caught.
  it("stubs ENTITY_IS_DELETED → DISCARD pending OBQ-3 resolution", () => {
    expect(deriveSuggestedResolution("ENTITY_IS_DELETED")).toBe("DISCARD");
  });

  it("returns null for unknown SF error codes", () => {
    expect(deriveSuggestedResolution("SOMETHING_NEW")).toBeNull();
    expect(deriveSuggestedResolution(null)).toBeNull();
  });
});

describe("buildQueuePendingBody", () => {
  it("assembles the §7.5.1 wire envelope", () => {
    const result: PendingQueueResult = {
      rows: [row()],
      counts: { ...emptyCounts(), review_required_reassigned: 1 },
      queueDepth: 1,
    };

    const body = buildQueuePendingBody({
      specialistId: SPECIALIST_ID,
      result,
    });

    expect(body.specialistId).toBe(SPECIALIST_ID);
    expect(body.queueDepth).toBe(1);
    expect(body.maxQueueDepth).toBe(100);
    expect(body.counts.review_required_reassigned).toBe(1);
    expect(body.items).toHaveLength(1);

    const item = body.items[0]!;
    expect(item.queueItemId).toBe("00000000-0000-0000-0000-000000000001");
    expect(item.actionType).toBe("call.logged");
    expect(item.status).toBe("review_required_reassigned");
    expect(item.createdAt).toBe("2026-05-09T10:23:00.000Z");
    expect(item.lastAttemptAt).toBe("2026-05-09T14:35:00.000Z");
    expect(item.retryCount).toBe(2);
    expect(item.errorDetails).toEqual({
      sfErrorCode: "INVALID_CROSS_REFERENCE_KEY",
      message: "Participant P was reassigned.",
    });
    expect(item.payloadPreview).toEqual({
      status: "Completed",
      snippet: "Brief check-in call",
    });
    expect(item.resolutionOptions).toEqual(RESOLUTION_OPTIONS);
    expect(item.suggestedResolution).toBe("ESCALATE_TO_SUPERVISOR");
  });

  it("emits an empty envelope for a specialist with no pending items", () => {
    const result: PendingQueueResult = {
      rows: [],
      counts: emptyCounts(),
      queueDepth: 0,
    };
    const body = buildQueuePendingBody({
      specialistId: SPECIALIST_ID,
      result,
    });
    expect(body.items).toEqual([]);
    expect(body.queueDepth).toBe(0);
    expect(body.counts).toEqual(emptyCounts());
    expect(body.maxQueueDepth).toBe(100);
  });

  it("caps errorDetails.message at 200 chars (defensive against SF verbosity)", () => {
    const longMessage = "x".repeat(300);
    const result: PendingQueueResult = {
      rows: [
        row({
          errorDetails: {
            sfErrorCode: "INVALID_CROSS_REFERENCE_KEY",
            message: longMessage,
          },
        }),
      ],
      counts: { ...emptyCounts(), review_required_reassigned: 1 },
      queueDepth: 1,
    };
    const body = buildQueuePendingBody({
      specialistId: SPECIALIST_ID,
      result,
    });
    expect(body.items[0]?.errorDetails?.message).toHaveLength(200);
    expect(body.items[0]?.errorDetails?.message).toMatch(/…$/);
  });

  it("nulls lastAttemptAt and errorDetails when absent", () => {
    const result: PendingQueueResult = {
      rows: [
        row({
          lastAttemptAt: null,
          errorDetails: null,
          retryCount: 0,
          status: "pending_sync",
        }),
      ],
      counts: { ...emptyCounts(), pending_sync: 1 },
      queueDepth: 1,
    };
    const body = buildQueuePendingBody({
      specialistId: SPECIALIST_ID,
      result,
    });
    const item = body.items[0]!;
    expect(item.lastAttemptAt).toBeNull();
    expect(item.errorDetails).toBeNull();
    expect(item.suggestedResolution).toBeNull();
  });
});
