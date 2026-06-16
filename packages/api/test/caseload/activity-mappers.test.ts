import type {
  CaseNoteActivityRecord,
  SmsActivityRecord,
} from "@anthos/integrations";
import { describe, expect, it } from "vitest";

import { mapActivityEvents } from "../../src/caseload/activity-mappers.js";

const PE = "a1kU800000pjmA1IAI";
const PE2 = "a1kU800000pjmB2IAI";

function cn(partial: Partial<CaseNoteActivityRecord>): CaseNoteActivityRecord {
  return {
    Id: "a1dU800000C516DIAR",
    Program_Enrollment__c: PE,
    Type__c: "Check In",
    Status__c: "Completed",
    Contact_Type__c: "Phone",
    Service_Date__c: "2026-06-10",
    ...partial,
  };
}

function sms(partial: Partial<SmsActivityRecord>): SmsActivityRecord {
  return {
    Id: "a2xU800000Z9999IAR",
    Program_Enrollment__c: PE,
    Mogli_SMS__Direction__c: "Outgoing",
    Mogli_SMS__Status__c: "Queued",
    CreatedDate: "2026-06-11T14:00:00.000+0000",
    ...partial,
  };
}

const NAMES = new Map<string, string | null>([
  [PE, "Casey Rivera"],
  [PE2, null],
]);

function mapOne(record: Partial<CaseNoteActivityRecord>) {
  return mapActivityEvents({ caseNotes: [cn(record)], sms: [], nameById: NAMES })[0]!;
}

describe("mapActivityEvents — case notes", () => {
  it("maps a scheduled Stability Meeting to an upcoming visit", () => {
    const ev = mapOne({ Type__c: "Stability Meeting", Status__c: "Scheduled", Contact_Type__c: "In Person" });
    expect(ev).toMatchObject({ kind: "visit", status: "scheduled", label: "Stability Meeting" });
  });

  it("maps a completed Stability Meeting to a past visit", () => {
    const ev = mapOne({ Type__c: "Stability Meeting", Status__c: "Completed" });
    expect(ev).toMatchObject({ kind: "visit", status: "completed" });
  });

  it("routes non-visit case notes by contact type", () => {
    expect(mapOne({ Type__c: "Check In", Contact_Type__c: "Phone" }).kind).toBe("phone");
    expect(mapOne({ Type__c: "Other", Contact_Type__c: "Email" }).kind).toBe("email");
    expect(mapOne({ Type__c: "Other", Contact_Type__c: "Text/SMS" }).kind).toBe("sms");
    expect(mapOne({ Type__c: "Move in Meeting", Contact_Type__c: "In Person" }).kind).toBe("visit");
  });

  it("tags participant id + name, namespaces the id, and uses Service_Date as ymd", () => {
    const ev = mapOne({ Service_Date__c: "2026-06-10" });
    expect(ev.participantId).toBe(PE);
    expect(ev.participantName).toBe("Casey Rivera");
    expect(ev.id).toBe(`${PE}:cn-a1dU800000C516DIAR`);
    expect(ev.ymd).toBe("2026-06-10");
  });

  it("drops an undated case note", () => {
    const events = mapActivityEvents({
      caseNotes: [cn({ Service_Date__c: null })],
      sms: [],
      nameById: NAMES,
    });
    expect(events).toHaveLength(0);
  });

  it("falls back to a null name when the PE is absent from the name map", () => {
    const ev = mapActivityEvents({
      caseNotes: [cn({ Program_Enrollment__c: PE2 })],
      sms: [],
      nameById: NAMES,
    })[0]!;
    expect(ev.participantName).toBeNull();
  });
});

describe("mapActivityEvents — SMS", () => {
  it("maps an SMS to kind sms with normalized status and UTC day", () => {
    const ev = mapActivityEvents({
      caseNotes: [],
      sms: [sms({ Mogli_SMS__Status__c: "Queued", CreatedDate: "2026-06-11T23:30:00.000+0000" })],
      nameById: NAMES,
    })[0]!;
    expect(ev).toMatchObject({ kind: "sms", status: "queued", label: "SMS", ymd: "2026-06-11" });
    expect(ev.id).toBe(`${PE}:sms-a2xU800000Z9999IAR`);
  });

  it("normalizes an Error SMS status", () => {
    const ev = mapActivityEvents({ caseNotes: [], sms: [sms({ Mogli_SMS__Status__c: "Error" })], nameById: NAMES })[0]!;
    expect(ev.status).toBe("error");
  });
});

describe("mapActivityEvents — PII firewall", () => {
  it("never emits a body/note/message field (only the metadata-only keys)", () => {
    const events = mapActivityEvents({
      caseNotes: [cn({})],
      sms: [sms({})],
      nameById: NAMES,
    });
    const allowed = new Set([
      "id",
      "participantId",
      "participantName",
      "ymd",
      "kind",
      "status",
      "label",
    ]);
    for (const ev of events) {
      for (const key of Object.keys(ev)) {
        expect(allowed.has(key)).toBe(true);
      }
    }
  });
});
