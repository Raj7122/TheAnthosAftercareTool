"use client";

import {
  Calendar,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useMemo, useState } from "react";

import type { CaseloadItem } from "@anthos/api";

import type { DeviceVariant } from "@/lib/device";

import {
  buildCaseloadCalendarEvents,
  type CaseloadCalendarEvent,
} from "../../_lib/calendar/caseload-events";
import {
  eventDotClass,
  eventGlyph,
  eventKindLabel,
  groupEventsByDay,
  legendKinds,
  type CalendarEvent,
} from "../../_lib/calendar/events";
import {
  addMonths,
  buildMonthMatrix,
  formatYmdLong,
  monthLabel,
  monthOfYmd,
  todayYmdUtc,
  WEEKDAY_LABELS,
} from "../../_lib/calendar/month";
import type { CaseloadActivityState } from "../_lib/useCaseloadActivity";

// F-23 — caseload-wide activity calendar. Plots every dated activity across ALL
// of the specialist's caseload rows on a shared timeline so the specialist can
// plan across participants. Phase A events (stability checkpoints, next-visit-
// due, opened barriers) come from the F-02 hydrated cache (`items`); Phase B
// events (scheduled/completed visits, logged comms, SMS) are fetched and passed
// in via `activityEvents`. Laptop gets a month grid; tablet (10-inch portrait,
// F-13 BR-65: no horizontal scroll) gets an agenda list. Per-kind legend chips
// toggle event kinds on/off to tame density. Each event links to F-07.
interface Props {
  readonly items: ReadonlyArray<CaseloadItem>;
  readonly variant: DeviceVariant;
  readonly activityEvents?: ReadonlyArray<CaseloadCalendarEvent>;
  readonly activityState?: CaseloadActivityState;
  // This session's optimistically-logged repairs (client-only), merged
  // alongside the Phase A/B events so a just-logged repair shows on its day
  // immediately. Reset on reload.
  readonly optimisticRepairEvents?: ReadonlyArray<CaseloadCalendarEvent>;
  // Same, for this session's logged case notes.
  readonly optimisticCaseNoteEvents?: ReadonlyArray<CaseloadCalendarEvent>;
}

type EventKind = CalendarEvent["kind"];

interface CalendarBodyProps {
  readonly eventsByDay: ReadonlyMap<string, ReadonlyArray<CalendarEvent>>;
  readonly legend: ReadonlyArray<EventKind>;
  readonly hiddenKinds: ReadonlySet<EventKind>;
  readonly onToggleKind: (kind: EventKind) => void;
  readonly activityState: CaseloadActivityState;
}

const MAX_DOTS = 3;
const EMPTY_CASELOAD_EVENTS: ReadonlyArray<CaseloadCalendarEvent> = Object.freeze([]);

export function CaseloadCalendar({
  items,
  variant,
  activityEvents = EMPTY_CASELOAD_EVENTS,
  activityState = "idle",
  optimisticRepairEvents = EMPTY_CASELOAD_EVENTS,
  optimisticCaseNoteEvents = EMPTY_CASELOAD_EVENTS,
}: Props) {
  const [hiddenKinds, setHiddenKinds] = useState<ReadonlySet<EventKind>>(
    () => new Set(),
  );
  const onToggleKind = useCallback((kind: EventKind) => {
    setHiddenKinds((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  }, []);

  // Phase A (cache-derived) + Phase B (fetched) + this session's optimistic
  // repairs, merged.
  const allEvents = useMemo(
    () => [
      ...buildCaseloadCalendarEvents(items),
      ...activityEvents,
      ...optimisticRepairEvents,
      ...optimisticCaseNoteEvents,
    ],
    [items, activityEvents, optimisticRepairEvents, optimisticCaseNoteEvents],
  );
  // Full set of kinds present — drives the filter chips, independent of what's
  // currently hidden, so a toggled-off kind keeps its chip.
  const legend = useMemo(() => legendKinds(allEvents), [allEvents]);
  const visibleEvents = useMemo(
    () => allEvents.filter((e) => !hiddenKinds.has(e.kind)),
    [allEvents, hiddenKinds],
  );
  const eventsByDay = useMemo(
    () => groupEventsByDay(visibleEvents),
    [visibleEvents],
  );

  const body: CalendarBodyProps = {
    eventsByDay,
    legend,
    hiddenKinds,
    onToggleKind,
    activityState,
  };

  if (variant === "tablet") return <CaseloadAgenda {...body} />;
  return <CaseloadMonthGrid {...body} />;
}

// --- Laptop: month grid + selected-day / this-month side rail ----------------

function CaseloadMonthGrid({
  eventsByDay,
  legend,
  hiddenKinds,
  onToggleKind,
  activityState,
}: CalendarBodyProps) {
  const todayKey = todayYmdUtc();
  const initialMonth = useMemo(
    () => monthOfYmd(todayKey) ?? { year: 1970, month: 0 },
    [todayKey],
  );
  const [view, setView] = useState(initialMonth);
  const [selectedYmd, setSelectedYmd] = useState<string>(todayKey);

  const matrix = useMemo(
    () => buildMonthMatrix(view.year, view.month, todayKey),
    [view.year, view.month, todayKey],
  );
  const selectedEvents = asCaseloadEvents(
    eventsByDay.get(selectedYmd) ?? EMPTY_EVENTS,
  );

  function goToday() {
    const m = monthOfYmd(todayKey);
    if (m !== null) setView(m);
    setSelectedYmd(todayKey);
  }

  // Per-kind tally for the visible month — drives the "This month" stat tiles
  // and the "N events this period" footer. Reads the already-filtered
  // `eventsByDay`, so toggling a legend chip off also drops it from the totals.
  const summary = useMemo(
    () => monthSummary(eventsByDay, view.year, view.month),
    [eventsByDay, view.year, view.month],
  );

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
      {/* Left — month grid card (sectioned: header bar / day labels / grid /
          legend bar), edge-to-edge per the Figma layout. */}
      <section
        aria-labelledby="caseload-calendar-heading"
        className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm lg:col-span-2"
      >
        {/* Header bar */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-5 py-4">
          <h2
            id="caseload-calendar-heading"
            className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500"
          >
            <Calendar aria-hidden="true" className="h-4 w-4 text-indigo-600" />
            Caseload calendar
          </h2>
          <div className="flex items-center gap-2">
            <NavButton
              label="Previous month"
              onClick={() => setView((v) => addMonths(v.year, v.month, -1))}
            >
              <ChevronLeft aria-hidden="true" className="h-4 w-4" />
            </NavButton>
            <span className="min-w-[120px] text-center text-sm font-semibold tabular-nums text-slate-900">
              {monthLabel(view.year, view.month)}
            </span>
            <NavButton
              label="Next month"
              onClick={() => setView((v) => addMonths(v.year, v.month, 1))}
            >
              <ChevronRight aria-hidden="true" className="h-4 w-4" />
            </NavButton>
            <button
              type="button"
              onClick={goToday}
              className="ml-1 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Today
            </button>
          </div>
        </div>

        {/* Weekday header */}
        <div className="grid grid-cols-7 border-b border-slate-100">
          {WEEKDAY_LABELS.map((wd) => (
            <div
              key={wd}
              className="py-3 text-center text-[11px] font-semibold uppercase tracking-[0.06em] text-slate-400"
            >
              {wd.toUpperCase()}
            </div>
          ))}
        </div>

        {/* Day grid */}
        <div role="grid" aria-label="Caseload calendar" className="grid grid-cols-7">
          {matrix.weeks.map((week, wi) => (
            <div key={wi} role="row" className="contents">
              {week.map((cell) => {
                const dayEvents = eventsByDay.get(cell.ymd) ?? EMPTY_EVENTS;
                const isSelected = cell.ymd === selectedYmd;
                const isLastRow = wi === matrix.weeks.length - 1;
                return (
                  <button
                    key={cell.ymd}
                    type="button"
                    role="gridcell"
                    aria-selected={isSelected}
                    aria-label={cellAriaLabel(cell.ymd, dayEvents.length, cell.isToday)}
                    onClick={() => {
                      setSelectedYmd(cell.ymd);
                      if (!cell.inMonth) {
                        const m = monthOfYmd(cell.ymd);
                        if (m !== null) setView(m);
                      }
                    }}
                    className={[
                      "group flex min-h-[4rem] flex-col items-center gap-1 border-b border-r border-slate-100 px-1 py-3 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                      isLastRow ? "border-b-0" : "",
                      cell.inMonth ? "" : "opacity-40",
                      isSelected ? "bg-indigo-50" : "hover:bg-slate-50",
                    ].join(" ")}
                  >
                    <span
                      className={[
                        "flex h-7 w-7 items-center justify-center rounded-full text-[13px] tabular-nums transition-all",
                        cell.isToday
                          ? "bg-indigo-600 font-semibold text-white"
                          : isSelected
                            ? "bg-indigo-100 font-semibold text-indigo-700"
                            : "text-slate-700 group-hover:text-slate-900",
                      ].join(" ")}
                    >
                      {cell.day}
                    </span>
                    <DayDots events={dayEvents} />
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        {/* Legend (doubles as per-kind filter) + period count */}
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-t border-slate-100 bg-slate-50/50 px-5 py-3">
          <LegendFilter
            legend={legend}
            hiddenKinds={hiddenKinds}
            onToggle={onToggleKind}
            className=""
          />
          <span className="ml-auto text-[11px] text-slate-400">
            {summary.total} event{summary.total === 1 ? "" : "s"} this period
          </span>
        </div>
        {activityState !== "idle" && (
          <div className="px-5 pb-3">
            <ActivityNote state={activityState} />
          </div>
        )}
      </section>

      {/* Right — selected day + this-month summary */}
      <aside className="flex flex-col gap-4">
        <SelectedDayCard selectedYmd={selectedYmd} events={selectedEvents} />
        <ThisMonthCard summary={summary} />
      </aside>
    </div>
  );
}

interface MonthSummary {
  readonly visits: number;
  readonly checkpoints: number;
  readonly barriers: number;
  readonly total: number;
}

// Tally events falling in `year`/`month` by stat-tile bucket. `ymd` keys are
// `YYYY-MM-DD`, so a `YYYY-MM` prefix match isolates the visible month.
function monthSummary(
  eventsByDay: ReadonlyMap<string, ReadonlyArray<CalendarEvent>>,
  year: number,
  month: number,
): MonthSummary {
  const prefix = `${year}-${String(month + 1).padStart(2, "0")}`;
  let visits = 0;
  let checkpoints = 0;
  let barriers = 0;
  let total = 0;
  for (const [ymd, events] of eventsByDay) {
    if (!ymd.startsWith(prefix)) continue;
    for (const ev of events) {
      total += 1;
      if (ev.kind === "visit" || ev.kind === "visit_due") visits += 1;
      else if (ev.kind === "checkpoint") checkpoints += 1;
      else if (ev.kind === "barrier") barriers += 1;
    }
  }
  return { visits, checkpoints, barriers, total };
}

// Right-rail card: the selected day's full date + every event on it, each a
// tap-through to the participant's profile (F-07). Sectioned header + a
// divided list per the Figma layout.
function SelectedDayCard({
  selectedYmd,
  events,
}: {
  readonly selectedYmd: string;
  readonly events: ReadonlyArray<CaseloadCalendarEvent>;
}) {
  return (
    <section
      aria-labelledby="selected-day-heading"
      className="flex-1 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm"
    >
      <div className="border-b border-slate-100 px-5 py-4">
        <h2
          id="selected-day-heading"
          className="text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500"
        >
          Selected day
        </h2>
        <p className="mt-0.5 text-sm font-semibold leading-tight text-slate-900">
          {formatYmdLong(selectedYmd)}
        </p>
      </div>
      {events.length === 0 ? (
        <div className="flex flex-col items-center justify-center px-5 py-10 text-center">
          <span className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-slate-100">
            <Calendar aria-hidden="true" className="h-5 w-5 text-slate-400" />
          </span>
          <p className="text-sm text-slate-500">No events on this day</p>
        </div>
      ) : (
        <ul className="divide-y divide-slate-100">
          {events.map((ev) => (
            <SelectedDayEventRow key={ev.id} event={ev} />
          ))}
        </ul>
      )}
    </section>
  );
}

// Status-pill palette + derivation. Checkpoints carry an explicit cycle state;
// other kinds fall back to a short status keyword from `detail`.
const PILL = {
  sky: "bg-sky-50 text-sky-700 ring-sky-200",
  rose: "bg-rose-50 text-rose-700 ring-rose-200",
  emerald: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  amber: "bg-amber-50 text-amber-700 ring-amber-200",
} as const;

function statusPill(
  event: CaseloadCalendarEvent,
): { readonly label: string; readonly classes: string } | null {
  if (event.state !== undefined) {
    switch (event.state) {
      case "complete":
        return { label: "Completed", classes: PILL.emerald };
      case "overdue":
        return { label: "Overdue", classes: PILL.rose };
      case "due":
        return { label: "Due soon", classes: PILL.amber };
      case "catch_up":
        return { label: "Catch-up", classes: PILL.amber };
      case "future":
        return { label: "Upcoming", classes: PILL.sky };
    }
  }
  const detail = event.detail?.trim();
  // Only short, status-like details read well as a pill; longer free text
  // (e.g. a comms summary) stays as the description line above.
  if (detail === undefined || detail === "" || detail.length > 28) return null;
  const lower = detail.toLowerCase();
  if (lower.includes("overdue") || lower.includes("missed")) {
    return { label: detail, classes: PILL.rose };
  }
  if (lower.includes("complete")) {
    return { label: detail, classes: PILL.emerald };
  }
  return { label: detail, classes: PILL.sky };
}

// One selected-day row: status dot, participant name (+ hover deep-link glyph),
// event title, then a kind-label + status pill. Whole row links to F-07.
function SelectedDayEventRow({
  event,
}: {
  readonly event: CaseloadCalendarEvent;
}) {
  const pill = statusPill(event);
  return (
    <li>
      <Link
        href={`/participants/${event.participantId}`}
        className="group block px-5 py-4 transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <div className="flex items-start gap-3">
          <span
            aria-hidden="true"
            className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${eventDotClass(event.kind, event.state)}`}
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-[13px] font-semibold text-slate-900">
                {event.participantName ?? event.participantId}
              </span>
              <ExternalLink
                aria-hidden="true"
                className="h-3 w-3 shrink-0 text-slate-300 opacity-0 transition-opacity group-hover:opacity-100"
              />
            </div>
            <p className="mt-1 truncate text-xs text-slate-500">{event.title}</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className="text-[11px] text-slate-400">
                {eventKindLabel(event.kind)}
              </span>
              {pill !== null && (
                <>
                  <span aria-hidden="true" className="text-slate-200">
                    ·
                  </span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ${pill.classes}`}
                  >
                    {pill.label}
                  </span>
                </>
              )}
            </div>
          </div>
        </div>
      </Link>
    </li>
  );
}

// Right-rail card: stat tiles for the visible month.
function ThisMonthCard({ summary }: { readonly summary: MonthSummary }) {
  return (
    <section
      aria-labelledby="this-month-heading"
      className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
    >
      <h2
        id="this-month-heading"
        className="text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500"
      >
        This month
      </h2>
      <div className="mt-3 grid grid-cols-3 gap-3">
        <StatTile
          label="Visits"
          value={summary.visits}
          bg="bg-amber-50"
          valueColor="text-amber-600"
        />
        <StatTile
          label="Checkpoints"
          value={summary.checkpoints}
          bg="bg-slate-100"
          valueColor="text-slate-600"
        />
        <StatTile
          label="Barriers"
          value={summary.barriers}
          bg="bg-rose-50"
          valueColor="text-rose-600"
        />
      </div>
    </section>
  );
}

function StatTile({
  label,
  value,
  bg,
  valueColor,
}: {
  readonly label: string;
  readonly value: number;
  readonly bg: string;
  readonly valueColor: string;
}) {
  return (
    <div className={`rounded-lg p-3 text-center ${bg}`}>
      <div className={`text-[22px] font-bold leading-none tabular-nums ${valueColor}`}>
        {value}
      </div>
      <div className="mt-1 text-[10px] text-slate-500">{label}</div>
    </div>
  );
}

// --- Tablet: agenda list (no grid — F-13 BR-65 portrait fit) -----------------

function CaseloadAgenda({
  eventsByDay,
  legend,
  hiddenKinds,
  onToggleKind,
  activityState,
}: CalendarBodyProps) {
  // Day sections in chronological order. A grid would overflow a 10-inch
  // portrait viewport; a vertical list collapses gracefully (BR-65).
  const days = useMemo(() => [...eventsByDay.keys()].sort(), [eventsByDay]);
  return (
    <section
      aria-labelledby="caseload-calendar-heading"
      className="rounded-lg border bg-card p-3 shadow-sm"
    >
      <h2
        id="caseload-calendar-heading"
        className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
      >
        Caseload calendar
      </h2>
      <LegendFilter legend={legend} hiddenKinds={hiddenKinds} onToggle={onToggleKind} />
      <ActivityNote state={activityState} />
      {days.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">
          No activity on your caseload in this window.
        </p>
      ) : (
        <div className="mt-2 space-y-3">
          {days.map((ymd) => (
            <div key={ymd}>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {formatYmdLong(ymd)}
              </h3>
              <ul className="mt-1.5 space-y-1.5">
                {asCaseloadEvents(eventsByDay.get(ymd) ?? EMPTY_EVENTS).map(
                  (ev) => (
                    <EventRow key={ev.id} event={ev} />
                  ),
                )}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// --- Shared pieces -----------------------------------------------------------

const EMPTY_EVENTS: ReadonlyArray<CalendarEvent> = Object.freeze([]);

// `groupEventsByDay` is generic over CalendarEvent; the caseload aggregator and
// the activity hook only ever feed it CaseloadCalendarEvents, so this narrowing
// is sound. Kept local so the grouping helper stays shared with the
// per-participant calendar.
function asCaseloadEvents(
  events: ReadonlyArray<CalendarEvent>,
): ReadonlyArray<CaseloadCalendarEvent> {
  return events as ReadonlyArray<CaseloadCalendarEvent>;
}

// One agenda row: a single tap → the participant's profile (F-13 BR-62 single
// primary action per touch target).
function EventRow({ event }: { readonly event: CaseloadCalendarEvent }) {
  return (
    <li>
      <Link
        href={`/participants/${event.participantId}`}
        className="flex items-start gap-2 rounded-md border bg-background p-2 text-sm transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span aria-hidden="true" className="text-base leading-none">
          {eventGlyph(event.kind)}
        </span>
        <span className="min-w-0">
          <span className="font-medium">
            {event.participantName ?? event.participantId}
          </span>
          <span className="block truncate text-muted-foreground">
            {event.title}
            {event.detail !== undefined && event.detail !== ""
              ? ` — ${event.detail}`
              : ""}
          </span>
        </span>
      </Link>
    </li>
  );
}

// Legend chips double as per-kind filters: click to toggle a kind off/on
// (aria-pressed reflects "shown"). Default all shown. Lets a specialist tame a
// dense month without losing the at-a-glance color key.
function LegendFilter({
  legend,
  hiddenKinds,
  onToggle,
  className = "mt-2",
}: {
  readonly legend: ReadonlyArray<EventKind>;
  readonly hiddenKinds: ReadonlySet<EventKind>;
  readonly onToggle: (kind: EventKind) => void;
  // Margin defaults to the tablet-agenda spacing; the laptop footer passes "".
  readonly className?: string;
}) {
  if (legend.length === 0) return null;
  return (
    <div
      role="group"
      aria-label="Filter activity types"
      className={`flex flex-wrap gap-x-2 gap-y-1 ${className}`}
    >
      {legend.map((kind) => {
        const hidden = hiddenKinds.has(kind);
        return (
          <button
            key={kind}
            type="button"
            aria-pressed={!hidden}
            onClick={() => onToggle(kind)}
            className={[
              "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              hidden
                ? "text-muted-foreground/40 line-through"
                : "text-muted-foreground hover:text-foreground",
            ].join(" ")}
          >
            <span
              aria-hidden="true"
              className={`h-2 w-2 rounded-full ${eventDotClass(kind)} ${hidden ? "opacity-30" : ""}`}
            />
            {eventKindLabel(kind)}
          </button>
        );
      })}
    </div>
  );
}

// Non-blocking status for the Phase-B fetch. The grid/agenda always render the
// Phase-A (cache-derived) events; this only annotates the fetched layer.
function ActivityNote({ state }: { readonly state: CaseloadActivityState }) {
  if (state === "loading") {
    return (
      <p role="status" className="mt-2 text-[11px] text-muted-foreground">
        Loading scheduled visits &amp; messages…
      </p>
    );
  }
  if (state === "error") {
    return (
      <p role="note" className="mt-2 text-[11px] text-amber-700">
        Couldn&apos;t load messages &amp; scheduled visits — showing checkpoints
        &amp; barriers only.
      </p>
    );
  }
  return null;
}

function DayDots({ events }: { readonly events: ReadonlyArray<CalendarEvent> }) {
  if (events.length === 0) {
    return <span className="h-2" aria-hidden="true" />;
  }
  const shown = events.slice(0, MAX_DOTS);
  const overflow = events.length - shown.length;
  return (
    <span className="flex items-center gap-0.5" aria-hidden="true">
      {shown.map((ev) => (
        <span
          key={ev.id}
          className={`h-1.5 w-1.5 rounded-full ${eventDotClass(ev.kind, ev.state)}`}
        />
      ))}
      {overflow > 0 && (
        <span className="text-[9px] leading-none text-muted-foreground">
          +{overflow}
        </span>
      )}
    </span>
  );
}

function NavButton({
  label,
  onClick,
  children,
}: {
  readonly label: string;
  readonly onClick: () => void;
  readonly children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-600 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {children}
    </button>
  );
}

function cellAriaLabel(ymd: string, count: number, isToday: boolean): string {
  const base = formatYmdLong(ymd);
  const todayPart = isToday ? " (today)" : "";
  const eventPart =
    count === 0 ? ", no activity" : `, ${count} event${count === 1 ? "" : "s"}`;
  return `${base}${todayPart}${eventPart}`;
}
