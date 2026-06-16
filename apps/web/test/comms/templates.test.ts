import { describe, expect, it } from "vitest";

import {
  EMAIL_TEMPLATES,
  SENDER_NAME,
  SMS_TEMPLATES,
  TEMPLATE_OPTIONS,
  applyTemplate,
  deriveFirstName,
} from "../../app/_lib/comms/templates";

describe("applyTemplate", () => {
  it("substitutes every {{firstName}} occurrence", () => {
    expect(applyTemplate("Hi {{firstName}}, hi {{firstName}}", "Alfred")).toBe(
      "Hi Alfred, hi Alfred",
    );
  });

  it("is a no-op when the token is absent", () => {
    expect(applyTemplate("No token here", "Alfred")).toBe("No token here");
  });

  it("resolves the check-in email body to the participant's name", () => {
    const out = applyTemplate(EMAIL_TEMPLATES.checkin.body, "Alfred");
    expect(out).toContain("Hi Alfred,");
    expect(out).not.toContain("{{firstName}}");
    expect(out).toContain(SENDER_NAME);
  });
});

describe("deriveFirstName", () => {
  it("returns the friendly fallback for a null name", () => {
    expect(deriveFirstName(null)).toBe("there");
  });

  it("takes the first given name from a plain full name", () => {
    expect(deriveFirstName("Alfred Cooper")).toBe("Alfred");
  });

  it("skips an all-caps enrollment-status prefix", () => {
    expect(deriveFirstName("GRAD Alfred Cooper")).toBe("Alfred");
  });

  it("handles extra whitespace", () => {
    expect(deriveFirstName("  Alfred   Cooper ")).toBe("Alfred");
  });
});

describe("template tables", () => {
  it("covers all three intents for SMS and email", () => {
    for (const { key } of TEMPLATE_OPTIONS) {
      expect(SMS_TEMPLATES[key]).toBeTruthy();
      expect(EMAIL_TEMPLATES[key].subject).toBeTruthy();
      expect(EMAIL_TEMPLATES[key].body).toContain("{{firstName}}");
    }
  });

  it("SMS templates do not personalize (open with 'Hi —')", () => {
    for (const { key } of TEMPLATE_OPTIONS) {
      expect(SMS_TEMPLATES[key]).not.toContain("{{firstName}}");
      expect(SMS_TEMPLATES[key].startsWith("Hi —")).toBe(true);
    }
  });
});
