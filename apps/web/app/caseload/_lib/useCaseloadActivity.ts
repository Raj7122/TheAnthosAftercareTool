"use client";

import { useEffect, useRef, useState } from "react";

// Type-only import from @anthos/api — value imports drag `pg` into the client
// chunk (bundle-discipline memo).
import type { CaseloadActivityBody, CaseloadActivityEvent } from "@anthos/api";

import type { CaseloadCalendarEvent } from "../../_lib/calendar/caseload-events";

export type CaseloadActivityState = "idle" | "loading" | "ready" | "error";

export interface UseCaseloadActivityResult {
  readonly events: ReadonlyArray<CaseloadCalendarEvent>;
  readonly state: CaseloadActivityState;
}

// F-23 Phase B — fetches the caseload activity layer (scheduled/completed
// visits + logged comms + SMS) once, when the calendar surface is first active,
// and maps it to calendar events the grid/agenda merge with the Phase-A
// cache-derived events. The server applies the default window (prev/current/
// next month); month navigation outside it shows Phase-A-only events (a
// documented follow-up). On failure the calendar degrades to Phase-A events.
export function useCaseloadActivity(enabled: boolean): UseCaseloadActivityResult {
  const [events, setEvents] = useState<ReadonlyArray<CaseloadCalendarEvent>>([]);
  const [state, setState] = useState<CaseloadActivityState>("idle");
  // Fetch once — toggling back to queues and returning must not refetch
  // (AC-94 spirit: the toggle itself is cheap; the one activation fetches).
  const startedRef = useRef(false);

  useEffect(() => {
    if (!enabled || startedRef.current) return;
    startedRef.current = true;
    let cancelled = false;
    setState("loading");
    void (async () => {
      try {
        const res = await fetch("/api/v1/caseload/activity", {
          cache: "no-store",
          credentials: "same-origin",
        });
        if (!res.ok) throw new Error(`activity request failed (${res.status})`);
        const body = (await res.json()) as CaseloadActivityBody;
        if (cancelled) return;
        setEvents(body.items.map(toCalendarEvent));
        setState("ready");
      } catch {
        if (cancelled) return;
        // Graceful degradation — the calendar still renders Phase-A events.
        setState("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return { events, state };
}

function toCalendarEvent(ev: CaseloadActivityEvent): CaseloadCalendarEvent {
  const detail = statusLabel(ev.status);
  return {
    id: ev.id,
    ymd: ev.ymd,
    kind: ev.kind,
    title: ev.label,
    participantId: ev.participantId,
    participantName: ev.participantName,
    ...(detail !== "" ? { detail } : {}),
  };
}

function statusLabel(status: CaseloadActivityEvent["status"]): string {
  switch (status) {
    case "scheduled":
      return "Scheduled";
    case "completed":
      return "Completed";
    case "attempted":
      return "Attempted";
    case "canceled":
      return "Canceled";
    case "rescheduled":
      return "Rescheduled";
    case "queued":
      return "Queued";
    case "error":
      return "Failed";
    case "other":
      return "";
  }
}
