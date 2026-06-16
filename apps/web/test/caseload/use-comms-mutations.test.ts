import { describe, expect, it, vi } from "vitest";

import {
  submitScheduleVisit,
  submitSendEmail,
  submitSendSms,
} from "../../app/caseload/_lib/useCommsMutations";
import type { FetchLike } from "../../app/caseload/_lib/send-mutation";

function jsonResponse(status: number, body: unknown, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

describe("submitSendSms (E-11)", () => {
  it("POSTs to /sms with the caller's Idempotency-Key and returns body + traceId", async () => {
    const fetchImpl: FetchLike = vi.fn(async () =>
      jsonResponse(
        201,
        { smsId: "sms1", mogliMessageId: "sms1", deliveryStatus: "queued", scheduledFor: null },
        { "X-Trace-Id": "trace-1" },
      ),
    );
    const out = await submitSendSms(fetchImpl, "p1", "key-1", { body: "Hi", templateKey: "checkin" });

    expect(out.outcome).toBe("success");
    if (out.outcome === "success") {
      expect(out.body.smsId).toBe("sms1");
      expect(out.traceId).toBe("trace-1");
    }
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/v1/participants/p1/sms",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "Idempotency-Key": "key-1" }),
        body: JSON.stringify({ body: "Hi", templateKey: "checkin" }),
      }),
    );
  });

  it("includes scheduledFor when provided (the quiet-hours reschedule path)", async () => {
    const fetchImpl: FetchLike = vi.fn(async () =>
      jsonResponse(201, { smsId: "sms2", mogliMessageId: "sms2", deliveryStatus: "scheduled" }),
    );
    await submitSendSms(fetchImpl, "p1", "key-2", { body: "Hi", scheduledFor: "2026-05-22T12:00:00.000Z" });
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/v1/participants/p1/sms",
      expect.objectContaining({
        body: JSON.stringify({ body: "Hi", scheduledFor: "2026-05-22T12:00:00.000Z" }),
      }),
    );
  });

  it("maps a QUIET_HOURS_BLOCKED 409 to a failure carrying nextAllowedWindowStart", async () => {
    const fetchImpl: FetchLike = vi.fn(async () =>
      jsonResponse(409, {
        code: "QUIET_HOURS_BLOCKED",
        message: "blocked",
        traceId: "t",
        details: { nextAllowedWindowStart: "2026-05-22T12:00:00.000Z", participantTimezone: "America/New_York" },
      }),
    );
    const out = await submitSendSms(fetchImpl, "p1", "key-3", { body: "Hi" });
    expect(out.outcome).toBe("failure");
    if (out.outcome === "failure") {
      expect(out.failure.code).toBe("QUIET_HOURS_BLOCKED");
      expect(out.failure.nextAllowedWindowStart).toBe("2026-05-22T12:00:00.000Z");
    }
  });
});

describe("submitSendEmail (E-12)", () => {
  it("POSTs to /emails and returns the activity id", async () => {
    const fetchImpl: FetchLike = vi.fn(async () =>
      jsonResponse(202, { emailId: "act1", activityId: "act1", consentChecked: true }),
    );
    const out = await submitSendEmail(fetchImpl, "p1", "key-1", { subject: "Hi", body: "<p>x</p>" });
    expect(out.outcome).toBe("success");
    if (out.outcome === "success") expect(out.body.activityId).toBe("act1");
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/v1/participants/p1/emails",
      expect.objectContaining({ body: JSON.stringify({ subject: "Hi", body: "<p>x</p>" }) }),
    );
  });

  it("maps EMAIL_NOT_CONFIGURED to a failure", async () => {
    const fetchImpl: FetchLike = vi.fn(async () =>
      jsonResponse(503, { code: "EMAIL_NOT_CONFIGURED", message: "not enabled", traceId: "t" }),
    );
    const out = await submitSendEmail(fetchImpl, "p1", "key-1", { subject: "Hi", body: "x" });
    expect(out.outcome).toBe("failure");
    if (out.outcome === "failure") expect(out.failure.code).toBe("EMAIL_NOT_CONFIGURED");
  });
});

describe("submitScheduleVisit (E-13)", () => {
  it("POSTs to /visits and returns the visit id", async () => {
    const fetchImpl: FetchLike = vi.fn(async () =>
      jsonResponse(201, { visitId: "cn1", outlookEventId: null, outlookDegraded: true, statusLabel: "Scheduled" }),
    );
    const out = await submitScheduleVisit(fetchImpl, "p1", "key-1", {
      scheduledDateTime: "2026-06-15T12:00:00.000Z",
      notes: "quarterly",
    });
    expect(out.outcome).toBe("success");
    if (out.outcome === "success") {
      expect(out.body.visitId).toBe("cn1");
      expect(out.body.outlookDegraded).toBe(true);
    }
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/v1/participants/p1/visits",
      expect.objectContaining({
        body: JSON.stringify({ scheduledDateTime: "2026-06-15T12:00:00.000Z", notes: "quarterly" }),
      }),
    );
  });
});
