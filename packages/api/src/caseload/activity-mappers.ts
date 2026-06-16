// Pure mappers: raw SF activity rows → metadata-only CaseloadActivityEvents.
// No I/O. Unit-tested in isolation. The channel rule is the shared
// `classifyContactChannel` from @anthos/domain so the server and the SPA map
// channels identically.

import { classifyContactChannel } from "@anthos/domain";
import type {
  CaseNoteActivityRecord,
  SmsActivityRecord,
} from "@anthos/integrations";

import type {
  CaseloadActivityEvent,
  CaseloadActivityKind,
  CaseloadActivityStatus,
} from "./activity-dto.js";

const STABILITY_MEETING = "Stability Meeting";

export interface MapActivityEventsInput {
  readonly caseNotes: ReadonlyArray<CaseNoteActivityRecord>;
  readonly sms: ReadonlyArray<SmsActivityRecord>;
  // peId → participant display name (PII, wire-only). Rows whose PE is absent
  // from the map still render with a null name (defensive).
  readonly nameById: ReadonlyMap<string, string | null>;
}

export function mapActivityEvents(
  input: MapActivityEventsInput,
): ReadonlyArray<CaseloadActivityEvent> {
  const events: CaseloadActivityEvent[] = [];

  for (const cn of input.caseNotes) {
    const ymd = dateOnlyToYmd(cn.Service_Date__c);
    if (ymd === null) continue; // undated → not plottable
    const kind = caseNoteKind(cn.Type__c, cn.Contact_Type__c);
    events.push({
      id: `${cn.Program_Enrollment__c}:cn-${cn.Id}`,
      participantId: cn.Program_Enrollment__c,
      participantName: input.nameById.get(cn.Program_Enrollment__c) ?? null,
      ymd,
      kind,
      status: normalizeStatus(cn.Status__c),
      label: cn.Type__c !== null && cn.Type__c !== "" ? cn.Type__c : "Contact",
    });
  }

  for (const s of input.sms) {
    const ymd = isoDateTimeToYmd(s.CreatedDate);
    if (ymd === null) continue;
    events.push({
      id: `${s.Program_Enrollment__c}:sms-${s.Id}`,
      participantId: s.Program_Enrollment__c,
      participantName: input.nameById.get(s.Program_Enrollment__c) ?? null,
      ymd,
      kind: "sms",
      status: normalizeStatus(s.Mogli_SMS__Status__c),
      label: "SMS",
    });
  }

  return events;
}

// A Stability Meeting is always a visit (its Contact_Type — In Person / Phone /
// Zoom — is the modality, not the kind). Everything else routes by the shared
// channel classifier over Type + Contact_Type.
function caseNoteKind(
  type: string | null,
  contactType: string | null,
): CaseloadActivityKind {
  if (type === STABILITY_MEETING) return "visit";
  return classifyContactChannel([type, contactType]);
}

// Maps a free-form SF / Mogli status to the normalized union. Substring match
// so SF label variants ("Completed", "Complete", "Seen by Other Provider")
// resolve without a maintained table; unknown → "other".
function normalizeStatus(raw: string | null): CaseloadActivityStatus {
  if (raw === null || raw === "") return "other";
  const v = raw.toLowerCase();
  if (v.includes("reschedul")) return "rescheduled";
  if (v.includes("schedul")) return "scheduled";
  if (v.includes("complet") || v.includes("success") || v.includes("deliver")) {
    return "completed";
  }
  if (v.includes("attempt")) return "attempted";
  if (v.includes("cancel")) return "canceled";
  if (v.includes("error") || v.includes("fail")) return "error";
  if (v.includes("queue") || v.includes("sent") || v.includes("sending")) {
    return "queued";
  }
  return "other";
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// `Service_Date__c` is a date-only field — already `YYYY-MM-DD`. Validate shape;
// return null if absent/malformed (defensive — confirmed 100% populated).
function dateOnlyToYmd(value: string | null): string | null {
  if (value === null) return null;
  return ISO_DATE.test(value) ? value : null;
}

// `CreatedDate` is an ISO 8601 datetime — normalize to its UTC calendar day,
// matching the app's UTC-day keying.
function isoDateTimeToYmd(value: string | null): string | null {
  if (value === null || value === "") return null;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString().slice(0, 10);
}
