import { describe, expect, it } from "vitest";

import { quickActionDisabledCopy } from "../../app/participants/[id]/_lib/quick-action-copy";

describe("quickActionDisabledCopy — P1F-08 §Notes mapping", () => {
  it("returns undefined when no reason is supplied (action is enabled)", () => {
    expect(quickActionDisabledCopy(undefined)).toBeUndefined();
  });

  it("maps supervisor_read_only to the AC-29 banner copy", () => {
    expect(quickActionDisabledCopy("supervisor_read_only")).toBe(
      "Read-only access for supervisors",
    );
  });

  it("maps no_phone_on_file to its tooltip copy", () => {
    expect(quickActionDisabledCopy("no_phone_on_file")).toBe(
      "No phone number on file",
    );
  });

  it("maps no_email_on_file to its tooltip copy", () => {
    expect(quickActionDisabledCopy("no_email_on_file")).toBe(
      "No email on file",
    );
  });

  it("maps consent_unknown to the P1F-01 stub-aware copy", () => {
    expect(quickActionDisabledCopy("consent_unknown")).toBe(
      "Consent status unknown",
    );
  });
});
