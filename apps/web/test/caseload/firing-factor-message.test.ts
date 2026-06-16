import { describe, expect, it } from "vitest";

import type {
  CaseloadFactor,
  CaseloadHighestImpactFactor,
  CaseloadTriggeredInvariant,
} from "@anthos/api";

import { firingFactorMessage } from "../../app/_components/participant/firing-factor-message";

function highest(
  key: string,
  valueLabel: string,
  pointsContributed = 10,
): CaseloadHighestImpactFactor {
  return {
    key,
    name: `display-${key}`,
    valueLabel,
    weight: "×1.0",
    pointsContributed,
  };
}

function factor(
  key: string,
  valueLabel: string,
  valueNumeric: number,
): CaseloadFactor {
  return {
    key,
    name: `display-${key}`,
    valueLabel,
    valueNumeric,
    weight: "×1.0",
    pointsContributed: 10,
  };
}

function call(
  highestImpactFactor: CaseloadHighestImpactFactor | null,
  factors: ReadonlyArray<CaseloadFactor> = [],
  triggeredInvariants: ReadonlyArray<CaseloadTriggeredInvariant> = [],
): string {
  return firingFactorMessage({ highestImpactFactor, factors, triggeredInvariants });
}

describe("firingFactorMessage — EC-12 invariant precedence", () => {
  it("returns the first triggered invariant's display_label when present", () => {
    expect(
      call(
        highest("days_since_last_contact", "12 days"),
        [factor("days_since_last_contact", "12 days", 12)],
        [{ invariant_id: "INV_NO_CONTACT", display_label: "No contact ≥21 days" }],
      ),
    ).toBe("No contact ≥21 days");
  });
});

describe("firingFactorMessage — empty state", () => {
  it("returns 'On track' when highestImpactFactor is null (degraded row)", () => {
    expect(call(null)).toBe("On track");
  });

  it("returns 'On track' when the top factor contributes 0 points", () => {
    expect(call(highest("days_since_last_contact", "0 days", 0))).toBe("On track");
  });
});

describe("firingFactorMessage — per-factor copy", () => {
  it("days_since_last_contact: 'Hasn't been reached in N days' (uses valueNumeric)", () => {
    const top = highest("days_since_last_contact", "12 days");
    const factors = [factor("days_since_last_contact", "12 days", 12)];
    expect(call(top, factors)).toBe("Hasn't been reached in 12 days");
  });

  it("days_since_last_contact: singular 'day' for N=1", () => {
    const top = highest("days_since_last_contact", "1 days");
    const factors = [factor("days_since_last_contact", "1 days", 1)];
    expect(call(top, factors)).toBe("Hasn't been reached in 1 day");
  });

  it("days_since_last_contact: falls back to valueLabel when factors[] is missing the key", () => {
    const top = highest("days_since_last_contact", "12 days");
    expect(call(top, [])).toBe("12 days");
  });

  it("failed_attempts: 'N attempted contacts, 0 successful'", () => {
    const top = highest("failed_attempts", "3 attempts");
    const factors = [factor("failed_attempts", "3 attempts", 3)];
    expect(call(top, factors)).toBe("3 attempted contacts, 0 successful");
  });

  it("failed_attempts: singular for N=1", () => {
    const top = highest("failed_attempts", "1 attempt");
    const factors = [factor("failed_attempts", "1 attempt", 1)];
    expect(call(top, factors)).toBe("1 attempted contact, 0 successful");
  });

  it("stability_visit_state: 'Stability visit upcoming'", () => {
    expect(call(highest("stability_visit_state", "Upcoming"))).toBe(
      "Stability visit upcoming",
    );
  });

  it("stability_visit_state: 'Stability visit missed'", () => {
    expect(call(highest("stability_visit_state", "Missed"))).toBe(
      "Stability visit missed",
    );
  });

  it("voucher_recert_deadline: 'Voucher recert past due'", () => {
    expect(call(highest("voucher_recert_deadline", "past due"))).toBe(
      "Voucher recert past due",
    );
  });

  it("voucher_recert_deadline: 'Voucher recert in N days'", () => {
    expect(call(highest("voucher_recert_deadline", "recert in 5 days"))).toBe(
      "Voucher recert in 5 days",
    );
  });

  it("open_barriers: '3 open barriers' (count parsed from valueLabel)", () => {
    expect(call(highest("open_barriers", "3 open (2h/1m)"))).toBe(
      "3 open barriers",
    );
  });

  it("open_barriers: singular for 1", () => {
    expect(call(highest("open_barriers", "1 open (1h)"))).toBe("1 open barrier");
  });

  it("arrears: 'N open arrears'", () => {
    expect(call(highest("arrears", "2 open arrears"))).toBe("2 open arrears");
  });

  it("arrears: singular for 1", () => {
    expect(call(highest("arrears", "1 open arrear"))).toBe("1 open arrear");
  });

  it("aftercare_extended: 'Aftercare extended'", () => {
    expect(call(highest("aftercare_extended", "Extended"))).toBe("Aftercare extended");
  });

  it("recent_incident: 'Recent incident (30-day window)'", () => {
    expect(call(highest("recent_incident", "yes (30-day window)"))).toBe(
      "Recent incident (30-day window)",
    );
  });

  it("unknown key: falls back to engine valueLabel", () => {
    expect(call(highest("future_factor_not_yet_mapped", "engine label"))).toBe(
      "engine label",
    );
  });
});
