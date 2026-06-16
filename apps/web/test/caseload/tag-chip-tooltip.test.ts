import type { RowTag } from "@anthos/api";
import { describe, expect, it } from "vitest";

import { tagChipTooltip } from "../../app/_components/participant/tag-chip-tooltip";

function tag(key: string, label: string, severity: RowTag["severity"]): RowTag {
  return { key, label, severity };
}

describe("tagChipTooltip — action-anchored hover copy per RowTag key", () => {
  it("covers visit_overdue", () => {
    expect(tagChipTooltip(tag("visit_overdue", "Visit overdue", "high"))).toBe(
      "Visit overdue — upcoming visit date has passed; reschedule",
    );
  });

  it("covers cannot_reach", () => {
    expect(tagChipTooltip(tag("cannot_reach", "Cannot reach", "high"))).toBe(
      "Cannot reach — try a different contact channel",
    );
  });

  it("covers failed_attempts (the low-severity sibling chip)", () => {
    expect(
      tagChipTooltip(tag("failed_attempts", "Failed attempts", "low")),
    ).toBe("Multiple failed contact attempts — try a different channel");
  });

  it("covers voucher_critical_overdue (the past-due key form)", () => {
    expect(
      tagChipTooltip(
        tag("voucher_critical_overdue", "Voucher overdue", "high"),
      ),
    ).toBe("Voucher recertification overdue — escalate now");
  });

  it("parameterizes voucher_critical_<N>d with the day count", () => {
    expect(tagChipTooltip(tag("voucher_critical_12d", "Voucher 12d", "high"))).toBe(
      "Voucher recert due in 12 days — act this week",
    );
    expect(tagChipTooltip(tag("voucher_critical_1d", "Voucher 1d", "high"))).toBe(
      "Voucher recert due in 1 day — act this week",
    );
    // The derivation guarantees `1 <= N <= warningDays`, but the helper
    // tolerates any 2+ digit count without crashing.
    expect(
      tagChipTooltip(tag("voucher_critical_30d", "Voucher 30d", "high")),
    ).toBe("Voucher recert due in 30 days — act this week");
  });

  it("covers catch_up", () => {
    expect(tagChipTooltip(tag("catch_up", "Catch-up", "med"))).toBe(
      "Missed checkpoint — complete the specific visit to clear it",
    );
  });

  it("covers recent_incident", () => {
    expect(
      tagChipTooltip(tag("recent_incident", "Recent incident", "med")),
    ).toBe("Recent incident reported — check participant details");
  });

  it("covers arrears", () => {
    expect(tagChipTooltip(tag("arrears", "Arrears", "med"))).toBe(
      "Open arrears — review payment status",
    );
  });

  it("covers path_c_suppression (dead code today, kept ready)", () => {
    expect(
      tagChipTooltip(
        tag("path_c_suppression", "Path C suppression", "info"),
      ),
    ).toBe("Seen by another provider — suppression active (BR-21)");
  });

  it("falls back to tag.label when an unknown key arrives (forward-compat)", () => {
    expect(
      tagChipTooltip(tag("brand_new_signal_v2", "Brand-new signal", "info")),
    ).toBe("Brand-new signal");
  });
});
