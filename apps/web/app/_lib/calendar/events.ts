// Pure aggregator that flattens every dated activity on a participant detail
// body — plus this session's optimistic comms sends — into a single list of
// calendar events keyed by UTC `YYYY-MM-DD`. No I/O; unit-tested in isolation.

import type {
  CaseloadOpenBarrier,
  CaseloadStabilityVisit,
  PerAnchorState,
  PerCheckpointBreakdownDto,
  ParticipantRecentContact,
} from "@anthos/api";

import type { CommsChannel, OptimisticSend } from "../comms/types";
import { classifyContactChannel } from "../contacts/channel";
import { isoToYmd, ymdKeyUtc } from "./month";

const MS_PER_DAY = 86_400_000;

export type CalendarEventKind =
  | "checkpoint"
  | "visit_due"
  | "visit"
  | "phone"
  | "sms"
  | "email"
  | "barrier"
  | "repair"
  | "case_note";

export interface CalendarEvent {
  readonly id: string;
  readonly ymd: string; // UTC YYYY-MM-DD
  readonly kind: CalendarEventKind;
  readonly title: string;
  readonly detail?: string;
  // Only checkpoints carry a cycle state (drives the dot color).
  readonly state?: PerAnchorState;
}

export interface BuildCalendarEventsInput {
  readonly aftercareStartDate: string | null;
  readonly perCheckpointBreakdown: ReadonlyArray<PerCheckpointBreakdownDto>;
  readonly stabilityVisit: CaseloadStabilityVisit;
  readonly recentContacts: ReadonlyArray<ParticipantRecentContact>;
  readonly openBarriers: ReadonlyArray<CaseloadOpenBarrier>;
  readonly optimisticSends: ReadonlyArray<OptimisticSend>;
}

export function buildCalendarEvents(
  input: BuildCalendarEventsInput,
): ReadonlyArray<CalendarEvent> {
  const events: CalendarEvent[] = [];

  // Stability checkpoints + next-visit-due date. Extracted into shared builders
  // so the caseload-wide aggregator (`caseload-events.ts`) plots them with the
  // exact same arithmetic — the two calendars must never disagree on dates.
  events.push(
    ...buildCheckpointEvents(
      input.aftercareStartDate,
      input.perCheckpointBreakdown,
    ),
  );
  const due = buildVisitDueEvent(input.stabilityVisit);
  if (due !== null) events.push(due);

  // Logged contacts (server) — phone / sms / email / visit.
  input.recentContacts.forEach((c, idx) => {
    const ymd = isoToYmd(c.timestamp);
    if (ymd === null) return;
    const channel = classifyContactChannel([
      c.caseNoteType,
      c.contactType,
      c.channel,
    ]);
    events.push({
      id: `contact-${c.sfRecordId ?? c.contactId ?? idx}`,
      ymd,
      kind: channel,
      title: c.caseNoteType ?? contactKindTitle(channel),
      ...(c.summary !== null && c.summary !== "" ? { detail: c.summary } : {}),
    });
  });

  // Open barriers — plotted on the day they were opened.
  events.push(...buildBarrierEvents(input.openBarriers));

  // This session's optimistic sends (the shipped comms workflow). A scheduled
  // visit plots on its visit date (`eventDate`); SMS/email on the send instant.
  input.optimisticSends.forEach((s) => {
    const ymd = isoToYmd(s.eventDate ?? s.timestamp);
    if (ymd === null) return;
    events.push({
      id: s.id,
      ymd,
      kind: optimisticKind(s.channel),
      title: s.label,
      ...(s.summary !== "" ? { detail: s.summary } : {}),
    });
  });

  return events;
}

// Stability checkpoints — date computed from `aftercareStartDate` + anchor
// days (UTC), the same arithmetic CycleBreakdownPanel uses. Shared by the
// per-participant calendar and the caseload-wide aggregator. Returns `[]` when
// the start date is absent/unparseable.
export function buildCheckpointEvents(
  aftercareStartDate: string | null,
  perCheckpointBreakdown: ReadonlyArray<PerCheckpointBreakdownDto>,
): CalendarEvent[] {
  const startMs =
    aftercareStartDate === null ? Number.NaN : Date.parse(aftercareStartDate);
  if (Number.isNaN(startMs)) return [];
  return perCheckpointBreakdown.map((row) => ({
    id: `checkpoint-${row.anchor}`,
    ymd: ymdKeyUtc(new Date(startMs + row.anchor * MS_PER_DAY)),
    kind: "checkpoint" as const,
    title: `${row.anchor}-day stability visit`,
    detail: checkpointStateLabel(row.state),
    state: row.state,
  }));
}

// Next stability-visit due date — `null` when no due date is set.
export function buildVisitDueEvent(
  stabilityVisit: CaseloadStabilityVisit,
): CalendarEvent | null {
  const dueYmd = isoToYmd(stabilityVisit.nextDueDate);
  if (dueYmd === null) return null;
  return {
    id: "visit-due",
    ymd: dueYmd,
    kind: "visit_due",
    title: "Stability visit due",
    detail: stabilityVisit.statusLabel,
  };
}

// Open barriers — plotted on the day each was opened; skips barriers with no
// `openedAt`.
export function buildBarrierEvents(
  openBarriers: ReadonlyArray<CaseloadOpenBarrier>,
): CalendarEvent[] {
  const out: CalendarEvent[] = [];
  openBarriers.forEach((b, idx) => {
    const ymd = isoToYmd(b.openedAt);
    if (ymd === null) return;
    out.push({
      id: `barrier-${b.barrierId ?? idx}`,
      ymd,
      kind: "barrier",
      title: b.type !== null ? `Barrier: ${b.type}` : "Barrier opened",
      ...(b.severity !== null ? { detail: `${b.severity} severity` } : {}),
    });
  });
  return out;
}

// Repairs — plotted on the day each was logged (`identificationDate`, set to
// today on create). Takes a minimal shape so this module stays free of any
// repair-component dependency. The title is "Repair logged" — the note text is
// never surfaced inline on the calendar (clicking the event deep-links to the
// participant profile where the note is revealed on demand).
export function buildRepairEvents(
  repairs: ReadonlyArray<{
    readonly repairId: string;
    readonly identificationDate: string;
  }>,
): CalendarEvent[] {
  const out: CalendarEvent[] = [];
  repairs.forEach((r, idx) => {
    const ymd = isoToYmd(r.identificationDate);
    if (ymd === null) return;
    out.push({
      id: `repair-${r.repairId || idx}`,
      ymd,
      kind: "repair",
      title: "Repair logged",
    });
  });
  return out;
}

// Map an optimistic-send channel to its calendar event kind: a scheduled
// visit reads as a visit, a logged call as a phone contact, SMS/email as-is.
function optimisticKind(channel: CommsChannel): CalendarEventKind {
  switch (channel) {
    case "schedule":
      return "visit";
    case "call":
      return "phone";
    case "sms":
      return "sms";
    case "email":
      return "email";
  }
}

// Group events by their UTC day key for cell rendering.
export function groupEventsByDay(
  events: ReadonlyArray<CalendarEvent>,
): ReadonlyMap<string, ReadonlyArray<CalendarEvent>> {
  const map = new Map<string, CalendarEvent[]>();
  for (const ev of events) {
    const list = map.get(ev.ymd);
    if (list === undefined) map.set(ev.ymd, [ev]);
    else list.push(ev);
  }
  return map;
}

// --- Display helpers ---------------------------------------------------------

export function eventGlyph(kind: CalendarEventKind): string {
  switch (kind) {
    case "checkpoint":
      return "📍";
    case "visit_due":
      return "🗓️";
    case "visit":
      return "🤝";
    case "phone":
      return "📞";
    case "sms":
      return "💬";
    case "email":
      return "✉️";
    case "barrier":
      return "⚠️";
    case "repair":
      return "🔧";
    case "case_note":
      return "📝";
  }
}

// Tailwind background class for the day-cell dot. Checkpoints reuse the cycle
// palette; the rest use distinct, legend-able hues.
export function eventDotClass(
  kind: CalendarEventKind,
  state?: PerAnchorState,
): string {
  if (kind === "checkpoint") return checkpointDotClass(state);
  // Distinct hues across the comms kinds so phone / SMS / email / visit read
  // apart at a glance (blue / purple / pink / cyan).
  switch (kind) {
    case "visit_due":
      return "bg-amber-500";
    case "visit":
      return "bg-cyan-600";
    case "phone":
      return "bg-blue-600";
    case "sms":
      return "bg-violet-500";
    case "email":
      return "bg-pink-500";
    case "barrier":
      return "bg-red-700";
    case "repair":
      return "bg-orange-600";
    case "case_note":
      return "bg-teal-600";
  }
}

export function eventKindLabel(kind: CalendarEventKind): string {
  switch (kind) {
    case "checkpoint":
      return "Checkpoint";
    case "visit_due":
      return "Visit due";
    case "visit":
      return "Visit";
    case "phone":
      return "Phone";
    case "sms":
      return "SMS";
    case "email":
      return "Email";
    case "barrier":
      return "Barrier";
    case "repair":
      return "Repair";
    case "case_note":
      return "Case note";
  }
}

// Distinct kinds present in an event list, in legend order.
const LEGEND_ORDER: ReadonlyArray<CalendarEventKind> = [
  "checkpoint",
  "visit_due",
  "visit",
  "phone",
  "sms",
  "email",
  "barrier",
  "repair",
  "case_note",
];

export function legendKinds(
  events: ReadonlyArray<CalendarEvent>,
): ReadonlyArray<CalendarEventKind> {
  const present = new Set(events.map((e) => e.kind));
  return LEGEND_ORDER.filter((k) => present.has(k));
}

function checkpointDotClass(state?: PerAnchorState): string {
  switch (state) {
    case "complete":
      return "bg-cycleComplete";
    case "due":
      return "bg-cycleDue";
    case "overdue":
      return "bg-cycleOverdue";
    case "catch_up":
      return "bg-cycleCatchUp";
    case "future":
    case undefined:
      return "bg-zinc-300";
  }
}

function checkpointStateLabel(state: PerAnchorState): string {
  switch (state) {
    case "complete":
      return "Completed";
    case "due":
      return "Due soon";
    case "overdue":
      return "Overdue";
    case "catch_up":
      return "Catch-up window open";
    case "future":
      return "Upcoming";
  }
}

function contactKindTitle(kind: "phone" | "sms" | "email" | "visit"): string {
  switch (kind) {
    case "phone":
      return "Phone call";
    case "sms":
      return "SMS";
    case "email":
      return "Email";
    case "visit":
      return "Visit";
  }
}
