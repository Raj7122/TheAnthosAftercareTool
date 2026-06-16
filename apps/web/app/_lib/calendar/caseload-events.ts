// Pure aggregator that flattens every dated activity across ALL of a
// specialist's caseload rows into a single list of calendar events, each tagged
// with the participant it belongs to. Feeds the caseload-wide activity calendar
// (F-23). No I/O; unit-tested in isolation.
//
// Phase A scope: only the event kinds derivable from the F-02 hydrated cache —
// stability checkpoints, next-visit-due, and opened barriers. Logged comms and
// scheduled visits are NOT in the caseload cache today (no PE link on the case
// note object; `scheduledVisitDateTime` unhydrated); those layers arrive via a
// dedicated read path in Phase B. See the plan + CaseloadItem (dto.ts) limits.
//
// `@anthos/api` is imported type-only — a value import drags `pg` into the
// client webpack chunk (bundle-discipline memo).

import type { CaseloadItem } from "@anthos/api";

import {
  buildBarrierEvents,
  buildCheckpointEvents,
  buildVisitDueEvent,
  type CalendarEvent,
} from "./events";

// A caseload calendar event is a per-participant CalendarEvent plus the identity
// of the participant it belongs to, so the day agenda can show who each event is
// for and deep-link to their profile. `participantName` is null on a warm-cache
// read (displayName is PII, stripped at rest).
export interface CaseloadCalendarEvent extends CalendarEvent {
  readonly participantId: string;
  readonly participantName: string | null;
}

// Flatten the caseload's dated activity, reusing the exact per-type builders the
// per-participant calendar uses so the two never disagree on dates. Event ids
// are namespaced by participant to stay unique across rows.
export function buildCaseloadCalendarEvents(
  items: ReadonlyArray<CaseloadItem>,
): ReadonlyArray<CaseloadCalendarEvent> {
  const events: CaseloadCalendarEvent[] = [];
  for (const item of items) {
    // `?? null` guards a warm-cache item serialized before `aftercareStartDate`
    // joined the wire shape (would arrive `undefined`, not `null`).
    const base: CalendarEvent[] = [
      ...buildCheckpointEvents(
        item.aftercareStartDate ?? null,
        item.perCheckpointBreakdown,
      ),
      ...buildBarrierEvents(item.openBarriers),
    ];
    const due = buildVisitDueEvent(item.stabilityVisit);
    if (due !== null) base.push(due);

    for (const ev of base) {
      events.push({
        ...ev,
        id: `${item.participantId}:${ev.id}`,
        participantId: item.participantId,
        participantName: item.displayName,
      });
    }
  }
  return events;
}
