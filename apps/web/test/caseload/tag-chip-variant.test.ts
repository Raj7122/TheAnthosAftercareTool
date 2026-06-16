import { describe, expect, it } from "vitest";

import { tagChipVariant } from "../../app/_components/participant/tag-chip-variant";

describe("tagChipVariant — P1H-05 row-tag severity mapping", () => {
  it("maps high → barrierHigh (red)", () => {
    expect(tagChipVariant("high")).toBe("barrierHigh");
  });

  it("maps med → barrierMedium (amber)", () => {
    expect(tagChipVariant("med")).toBe("barrierMedium");
  });

  it("maps low → barrierLow (grey)", () => {
    expect(tagChipVariant("low")).toBe("barrierLow");
  });

  it("maps info → info (indigo) so neutral context signals don't read as low-risk", () => {
    expect(tagChipVariant("info")).toBe("info");
  });
});
