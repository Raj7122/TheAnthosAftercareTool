import { describe, expect, it } from "vitest";

import { maskPhone } from "../../app/participants/[id]/_lib/mask-phone";

describe("maskPhone — BR-40 identity-card masking (P1F-08)", () => {
  it("renders an em-dash for null (the empty-state today)", () => {
    expect(maskPhone(null)).toBe("—");
  });

  it("renders an em-dash for undefined (defensive against malformed wire data)", () => {
    expect(maskPhone(undefined)).toBe("—");
  });

  it("renders an em-dash for a digit-free string", () => {
    expect(maskPhone("n/a")).toBe("—");
  });

  it("masks a standard US 10-digit phone keeping the last 4 visible", () => {
    expect(maskPhone("5551234567")).toBe("(•••) •••-4567");
  });

  it("strips parentheses, hyphens, and dots before masking", () => {
    expect(maskPhone("(555) 123-4567")).toBe("(•••) •••-4567");
    expect(maskPhone("555.123.4567")).toBe("(•••) •••-4567");
  });

  it("strips a +1 country prefix", () => {
    expect(maskPhone("+1 555 123 4567")).toBe("(•••) •••-4567");
  });

  it("never reveals a sub-4-digit junk string (e.g. extension fragments)", () => {
    expect(maskPhone("12")).toBe("(•••) •••-••••");
  });

  it("takes the literal last 4 digits when an extension is appended", () => {
    // Documents the (acceptable) edge: the masker doesn't try to be clever
    // about extension parsing. An extension never identifies a participant on
    // its own, so leaking extension digits is no worse than a normal mask.
    expect(maskPhone("555-123-456788")).toBe("(•••) •••-6788");
  });
});
