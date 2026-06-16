import { describe, expect, it } from "vitest";

import { lastContactLabel } from "../../app/_components/participant/last-contact-label";

describe("lastContactLabel — P1H-05 row LAST CONTACT cell", () => {
  it("renders an em-dash when no successful contact has ever been recorded", () => {
    expect(lastContactLabel(null)).toBe("—");
  });

  it("renders 0d when the most recent successful contact is today", () => {
    expect(lastContactLabel(0)).toBe("0d");
  });

  it("renders N + 'd' for any positive day count", () => {
    expect(lastContactLabel(23)).toBe("23d");
    expect(lastContactLabel(365)).toBe("365d");
  });
});
