import { describe, expect, it } from "vitest";

import { barrierBadgeVariant } from "../../app/_components/participant/barrier-badge-variant";

describe("barrierBadgeVariant (BR-38)", () => {
  it("maps each FS v1.12 §F-06 severity tier to a distinct variant", () => {
    expect(barrierBadgeVariant("high")).toBe("barrierHigh");
    expect(barrierBadgeVariant("medium")).toBe("barrierMedium");
    expect(barrierBadgeVariant("low")).toBe("barrierLow");
  });

  it("renders an unclassified Barrier (severity=null) as muted, NOT as low — a missing classification is observably different from low-severity", () => {
    expect(barrierBadgeVariant(null)).toBe("muted");
  });
});
