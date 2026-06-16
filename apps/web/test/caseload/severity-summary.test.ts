import { describe, expect, it } from "vitest";

import type { RowTag } from "@anthos/api";

import { severitySummary } from "../../app/_components/participant/severity-summary";

const tag = (severity: RowTag["severity"], key: string = severity): RowTag => ({
  key,
  label: key,
  severity,
});

describe("severitySummary — F-02 row severity rollup", () => {
  it("any high tag → critical", () => {
    const result = severitySummary([tag("high", "visit_overdue"), tag("med")]);
    expect(result.level).toBe("critical");
    expect(result.label).toBe("Critical");
  });

  it("high wins even when med/low/info also present", () => {
    expect(
      severitySummary([tag("info"), tag("med"), tag("high"), tag("low")]).level,
    ).toBe("critical");
  });

  it("med tag with no high → attention", () => {
    const result = severitySummary([tag("med", "catch_up")]);
    expect(result.level).toBe("attention");
    expect(result.label).toBe("Attention Needed");
  });

  it("only low/info tags → monitor", () => {
    expect(severitySummary([tag("low"), tag("info")]).level).toBe("monitor");
  });

  it("no tags → monitor with zero issues", () => {
    const result = severitySummary([]);
    expect(result.level).toBe("monitor");
    expect(result.label).toBe("Monitor");
    expect(result.issueCount).toBe(0);
  });

  it("issueCount equals tags.length (cannot_reach + failed_attempts pair counts as 2)", () => {
    const result = severitySummary([
      tag("high", "visit_overdue"),
      tag("high", "cannot_reach"),
      tag("low", "failed_attempts"),
      tag("med", "arrears"),
    ]);
    expect(result.issueCount).toBe(4);
  });
});
