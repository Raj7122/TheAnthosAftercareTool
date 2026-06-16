import { describe, expect, it } from "vitest";

import { voucherRecertDeadlineFactor } from "../../../src/priority/factors/voucher-recert-deadline.js";
import { makeConfig, makeParticipant } from "../_fixtures.js";

const config = makeConfig(); // voucherRecertWarningDays = 30

describe("BR-19(i) — voucher_recert_deadline factor", () => {
  // GAP-17 closed 2026-05-19 (Julia): authoritative source is the SF-side
  // formula `Subsidy_Renewal_Re_Cert_Due_Date__c`. Past-due treatment uses
  // Julia's B4-with-hedge — "almost always stale data, no way of truly
  // knowing" — so past-due rows emit `dataQualityWarning` and contribute 0
  // rather than max-blasting urgency.

  it("returns 0 with 'no recert date' when field is missing", () => {
    const result = voucherRecertDeadlineFactor.compute(
      makeParticipant(),
      config,
    );
    expect(result).toEqual({
      valueLabel: "no recert date",
      valueNumeric: 0,
    });
  });

  it("returns 0 with 'no recert date' when field is null", () => {
    const result = voucherRecertDeadlineFactor.compute(
      makeParticipant({ voucher_recert_deadline: null }),
      config,
    );
    expect(result.valueNumeric).toBe(0);
    expect(result.valueLabel).toBe("no recert date");
    expect(result.dataQualityWarning).toBeUndefined();
  });

  it("returns 0 (no throw) when the field is the wrong type", () => {
    const result = voucherRecertDeadlineFactor.compute(
      makeParticipant({ voucher_recert_deadline: "30 days" }),
      config,
    );
    expect(result.valueNumeric).toBe(0);
    expect(result.valueLabel).toBe("no recert date");
  });

  it("returns 0 (no throw) when the field is NaN", () => {
    const result = voucherRecertDeadlineFactor.compute(
      makeParticipant({ voucher_recert_deadline: Number.NaN }),
      config,
    );
    expect(result.valueNumeric).toBe(0);
    expect(result.valueLabel).toBe("no recert date");
  });

  it("emits dataQualityWarning + 0 contribution for past-due (B4-with-hedge)", () => {
    const result = voucherRecertDeadlineFactor.compute(
      makeParticipant({ voucher_recert_deadline: -5 }),
      config,
    );
    // Chip stays visible via valueLabel; engine does NOT max-blast urgency.
    expect(result.valueLabel).toBe("past due");
    expect(result.valueNumeric).toBe(0);
    expect(result.dataQualityWarning).toBe("voucher_recert_past_due_likely_stale");
  });

  it("treats days == 0 as past-due (boundary)", () => {
    const result = voucherRecertDeadlineFactor.compute(
      makeParticipant({ voucher_recert_deadline: 0 }),
      config,
    );
    expect(result.valueLabel).toBe("past due");
    expect(result.valueNumeric).toBe(0);
    expect(result.dataQualityWarning).toBe("voucher_recert_past_due_likely_stale");
  });

  it("scales linearly within the warning window", () => {
    const result = voucherRecertDeadlineFactor.compute(
      makeParticipant({ voucher_recert_deadline: 10 }),
      config,
    );
    expect(result.valueLabel).toBe("recert in 10 days");
    expect(result.valueNumeric).toBe(20); // 30 - 10
    expect(result.dataQualityWarning).toBeUndefined();
  });

  it("contributes 0 when outside the warning window", () => {
    const result = voucherRecertDeadlineFactor.compute(
      makeParticipant({ voucher_recert_deadline: 90 }),
      config,
    );
    expect(result.valueNumeric).toBe(0);
    expect(result.valueLabel).toBe("recert in 90 days");
    expect(result.dataQualityWarning).toBeUndefined();
  });

  it("honors a customised voucherRecertWarningDays", () => {
    const wider = makeConfig({ voucherRecertWarningDays: 60 });
    const result = voucherRecertDeadlineFactor.compute(
      makeParticipant({ voucher_recert_deadline: 45 }),
      wider,
    );
    // 45 days is inside a 60-day window → contributes 60 - 45 = 15
    expect(result.valueNumeric).toBe(15);
  });

  it("treats exactly-at-window as inside the window", () => {
    const result = voucherRecertDeadlineFactor.compute(
      makeParticipant({ voucher_recert_deadline: 30 }),
      config,
    );
    expect(result.valueNumeric).toBe(0); // 30 - 30
  });
});
