import { describe, expect, it } from "vitest";

import { LOG_CALL_STATUSES, LOG_CALL_TYPES } from "@anthos/api";

import {
  LOG_CALL_DEFAULT_STATUS,
  LOG_CALL_DEFAULT_TYPE,
  LOG_CALL_STATUS_OPTIONS,
  LOG_CALL_TYPE_OPTIONS,
  SUMMARY_MAX_LEN,
  SUMMARY_MIN_LEN_COMPLETED,
} from "../../app/caseload/_lib/log-call-enums";

describe("LOG_CALL_STATUS_OPTIONS — wire/display split (BR-21 SBOP)", () => {
  it("exposes one option per wire status (no orphans either direction)", () => {
    const wireValues = LOG_CALL_STATUS_OPTIONS.map((o) => o.value).sort();
    expect(wireValues).toEqual([...LOG_CALL_STATUSES].sort());
  });

  it("renders the SBOP wire token as the BR-21 Path B 'Seen by Other Provider' label", () => {
    const sbop = LOG_CALL_STATUS_OPTIONS.find((o) => o.value === "SBOP");
    expect(sbop?.label).toBe("Seen by Other Provider");
  });

  it("defaults to Attempted (F-08 Inputs: most common outcome of a one-off field call)", () => {
    expect(LOG_CALL_DEFAULT_STATUS).toBe("Attempted");
  });
});

describe("LOG_CALL_TYPE_OPTIONS — exact wire spelling preserved", () => {
  it("exposes one option per wire type", () => {
    const wireValues = LOG_CALL_TYPE_OPTIONS.map((o) => o.value).sort();
    expect(wireValues).toEqual([...LOG_CALL_TYPES].sort());
  });

  it("preserves the v1.3 spec's lowercase-after-first-word casing on the wire values", () => {
    const resource = LOG_CALL_TYPE_OPTIONS.find((o) => o.value === "Resource referral");
    const crisis = LOG_CALL_TYPE_OPTIONS.find((o) => o.value === "Crisis support");
    expect(resource).toBeDefined();
    expect(crisis).toBeDefined();
  });

  it("defaults to Check In", () => {
    expect(LOG_CALL_DEFAULT_TYPE).toBe("Check In");
  });
});

describe("Summary bounds (VR-18 / BR-45)", () => {
  it("VR-18 minimum length is 10", () => {
    expect(SUMMARY_MIN_LEN_COMPLETED).toBe(10);
  });
  it("BR-45 max length is 2000", () => {
    expect(SUMMARY_MAX_LEN).toBe(2000);
  });
});
