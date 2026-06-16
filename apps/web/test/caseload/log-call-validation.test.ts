import { describe, expect, it } from "vitest";

import {
  computeServiceDateBounds,
  formatLocalYyyyMmDd,
  hasAnyError,
  mapFailureToFields,
  validate,
} from "../../app/caseload/_lib/log-call-validation";
import type { MutationFailure } from "../../app/caseload/_lib/send-mutation";

const NOW = new Date(2026, 4, 24); // 2026-05-24 local

function bounds() {
  return computeServiceDateBounds(NOW);
}

function failureOf(partial: Partial<MutationFailure>): MutationFailure {
  return {
    code: "X",
    message: "x",
    traceId: null,
    field: null,
    reason: null,
    ...partial,
  };
}

// Ticket / impl-plan shorthand: the two outcome branches below are written
// up as "BR-29 (Connected)" and "BR-30 (Failed)" in P1F-04 DoD. The actual
// FS citation is VR-18 (line 840); FS BR-29/BR-30 at lines 646-647 are F-05
// cycle rules unrelated to this guard. Test names preserve the ticket
// shorthand for DoD traceability.

describe("validate — BR-29 (Connected → summary required, ≥10 chars per VR-18)", () => {
  it("blocks submit when status=Completed and summary is empty", () => {
    const errors = validate({
      status: "Completed",
      type: "Check In",
      serviceDate: formatLocalYyyyMmDd(NOW),
      summary: "",
      dateBounds: bounds(),
    });
    expect(errors.summary).toMatch(/at least 10 characters/);
    expect(errors.summary).toContain("(0/10)");
    expect(hasAnyError(errors)).toBe(true);
  });

  it("blocks submit when status=Completed and summary is <10 chars after trim", () => {
    const errors = validate({
      status: "Completed",
      type: "Check In",
      serviceDate: formatLocalYyyyMmDd(NOW),
      summary: "   ok   ",
      dateBounds: bounds(),
    });
    expect(errors.summary).toContain("(2/10)");
  });

  it("passes when status=Completed and summary has ≥10 trim chars", () => {
    const errors = validate({
      status: "Completed",
      type: "Check In",
      serviceDate: formatLocalYyyyMmDd(NOW),
      summary: "spoke with participant about housing",
      dateBounds: bounds(),
    });
    expect(errors.summary).toBeUndefined();
    expect(hasAnyError(errors)).toBe(false);
  });

  it("passes at the boundary — exactly 10 trim chars (locks in `>=10` interpretation of VR-18)", () => {
    // FS v1.12 line 840 prose reads `>10 characters`, but both the client
    // (this validate fn) and the server's `runLogCall` use `< 10` (i.e.
    // 10 passes). Pinning the boundary here so the two halves cannot drift.
    const errors = validate({
      status: "Completed",
      type: "Check In",
      serviceDate: formatLocalYyyyMmDd(NOW),
      summary: "1234567890",
      dateBounds: bounds(),
    });
    expect(errors.summary).toBeUndefined();
  });

  it("fails at exactly 9 trim chars (one below the boundary)", () => {
    const errors = validate({
      status: "Completed",
      type: "Check In",
      serviceDate: formatLocalYyyyMmDd(NOW),
      summary: "123456789",
      dateBounds: bounds(),
    });
    expect(errors.summary).toContain("(9/10)");
  });
});

describe("validate — BR-30 (Failed branches → summary optional)", () => {
  const failedStatuses = [
    "Attempted",
    "Scheduled",
    "Rescheduled",
    "Canceled",
    "SBOP",
  ] as const;

  for (const status of failedStatuses) {
    it(`allows empty summary when status=${status}`, () => {
      const errors = validate({
        status,
        type: "Check In",
        serviceDate: formatLocalYyyyMmDd(NOW),
        summary: "",
        dateBounds: bounds(),
      });
      expect(errors.summary).toBeUndefined();
      expect(hasAnyError(errors)).toBe(false);
    });
  }
});

describe("validate — VR-17 service date window", () => {
  it("rejects empty service date", () => {
    const errors = validate({
      status: "Attempted",
      type: "Check In",
      serviceDate: "",
      summary: "",
      dateBounds: bounds(),
    });
    expect(errors.serviceDate).toBe("Service date is required.");
  });

  it("rejects a date older than 14 days", () => {
    const errors = validate({
      status: "Attempted",
      type: "Check In",
      serviceDate: "2026-05-09", // NOW - 15d
      summary: "",
      dateBounds: bounds(),
    });
    expect(errors.serviceDate).toMatch(/within the last 14 days/);
  });

  it("accepts today (boundary)", () => {
    const errors = validate({
      status: "Attempted",
      type: "Check In",
      serviceDate: formatLocalYyyyMmDd(NOW),
      summary: "",
      dateBounds: bounds(),
    });
    expect(errors.serviceDate).toBeUndefined();
  });

  it("accepts exactly today-14d (boundary)", () => {
    const errors = validate({
      status: "Attempted",
      type: "Check In",
      serviceDate: "2026-05-10", // NOW - 14d
      summary: "",
      dateBounds: bounds(),
    });
    expect(errors.serviceDate).toBeUndefined();
  });

  it("rejects a date after today (FS VR-17 stricter than server)", () => {
    const errors = validate({
      status: "Scheduled",
      type: "Check In",
      serviceDate: "2026-05-25", // NOW + 1d
      summary: "",
      dateBounds: bounds(),
    });
    expect(errors.serviceDate).toMatch(/within the last 14 days/);
  });
});

describe("computeServiceDateBounds — local timezone, 14-day window", () => {
  it("returns today + (today-14d) in YYYY-MM-DD", () => {
    const b = computeServiceDateBounds(NOW);
    expect(b.max).toBe("2026-05-24");
    expect(b.min).toBe("2026-05-10");
  });

  it("handles month rollover", () => {
    const b = computeServiceDateBounds(new Date(2026, 5, 2)); // 2026-06-02
    expect(b.min).toBe("2026-05-19");
    expect(b.max).toBe("2026-06-02");
  });
});

describe("formatLocalYyyyMmDd — local TZ ISO date", () => {
  it("zero-pads month and day", () => {
    expect(formatLocalYyyyMmDd(new Date(2026, 0, 5))).toBe("2026-01-05");
  });

  it("uses local clock, not UTC, so a late-night Eastern submit does not default to tomorrow", () => {
    // 11pm local time on May 24 → still "today" in local TZ
    const lateNight = new Date(2026, 4, 24, 23, 0);
    expect(formatLocalYyyyMmDd(lateNight)).toBe("2026-05-24");
  });
});

describe("mapFailureToFields — dedicated VR-18 envelope path", () => {
  it("surfaces SUMMARY_REQUIRED_FOR_COMPLETED inline on summary with (actual/min) counter", () => {
    const out = mapFailureToFields(
      failureOf({
        code: "SUMMARY_REQUIRED_FOR_COMPLETED",
        message: "Summary required.",
        rule: "VR-18",
        minLength: 10,
        actualLength: 3,
        field: "summary",
      }),
    );
    expect(out.bannerError).toBeNull();
    expect(out.fieldErrors).not.toBeNull();
    expect(out.fieldErrors?.summary).toContain("(3/10)");
  });

  it("falls back to defaults if minLength/actualLength are missing from the envelope", () => {
    const out = mapFailureToFields(
      failureOf({ code: "SUMMARY_REQUIRED_FOR_COMPLETED" }),
    );
    expect(out.fieldErrors?.summary).toContain("(0/10)");
  });
});

describe("mapFailureToFields — generic VALIDATION_FAILED with details.field", () => {
  it("routes summary-field validation to inline summary error", () => {
    const out = mapFailureToFields(
      failureOf({
        code: "VALIDATION_FAILED",
        message: "summary exceeds 2000 chars",
        field: "summary",
      }),
    );
    expect(out.bannerError).toBeNull();
    expect(out.fieldErrors?.summary).toBe("summary exceeds 2000 chars");
  });

  it("routes serviceDate-field validation to inline serviceDate error", () => {
    const out = mapFailureToFields(
      failureOf({
        code: "VALIDATION_FAILED",
        message: "serviceDate must be YYYY-MM-DD",
        field: "serviceDate",
      }),
    );
    expect(out.fieldErrors?.serviceDate).toBe("serviceDate must be YYYY-MM-DD");
  });

  it("routes status-field validation to inline status error", () => {
    const out = mapFailureToFields(
      failureOf({
        code: "VALIDATION_FAILED",
        message: "status must be a valid picklist value",
        field: "status",
      }),
    );
    expect(out.fieldErrors?.status).toBe("status must be a valid picklist value");
  });

  it("routes a non-form-field path (e.g. .strict() reject of `contactType`) to the banner", () => {
    const out = mapFailureToFields(
      failureOf({
        code: "VALIDATION_FAILED",
        message: "Unrecognized key: 'contactType'",
        field: "contactType",
      }),
    );
    expect(out.fieldErrors).toBeNull();
    expect(out.bannerError?.message).toContain("contactType");
  });
});

describe("mapFailureToFields — terminal failures (banner)", () => {
  for (const code of [
    "NOT_IN_OWN_CASELOAD",
    "ROLE_INSUFFICIENT_SCOPE",
    "RESOURCE_NOT_FOUND",
    "SF_UPSTREAM_UNAVAILABLE",
    "INTERNAL_ERROR",
    "NETWORK_ERROR",
    "HTTP_503",
  ]) {
    it(`surfaces ${code} as banner with no field highlight`, () => {
      const out = mapFailureToFields(failureOf({ code, message: `${code} msg` }));
      expect(out.fieldErrors).toBeNull();
      expect(out.bannerError?.code).toBe(code);
    });
  }
});
