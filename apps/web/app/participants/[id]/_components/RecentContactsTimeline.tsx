import type {
  CaseloadOpenBarrier,
  CaseloadStabilityVisit,
  ParticipantRecentContact,
} from "@anthos/api";

import { Badge } from "@/components/ui/badge";

import { useId, useState } from "react";

import { eventGlyph } from "../../../_lib/calendar/events";
import { formatYmdLong, isoToYmd } from "../../../_lib/calendar/month";
import type { OptimisticSend } from "../../../_lib/comms/types";
import type { OptimisticRepair } from "../../../_components/repairs/types";
import type { OptimisticCaseNote } from "../../../_components/case-notes/types";
import {
  channelGlyph,
  classifyContactChannel,
} from "../../../_lib/contacts/channel";

interface Props {
  readonly recentContacts: ReadonlyArray<ParticipantRecentContact>;
  // P1H-11 (demo) — client-only sends composed this session, surfaced "via
  // tool". Reset on reload; never persisted.
  readonly optimisticSends?: ReadonlyArray<OptimisticSend>;
  // This session's logged repairs (client-only, "via tool"). Rendered as a
  // collapsed "Repair logged at <date>" row that expands to reveal the note.
  readonly repairs?: ReadonlyArray<OptimisticRepair>;
  // This session's logged case notes — collapsed "Case note logged at <date>"
  // disclosure rows that expand to reveal the note.
  readonly caseNotes?: ReadonlyArray<OptimisticCaseNote>;
  // P3D-01 (F-23) — opened barriers and the next stability-visit-due date are
  // folded into the timeline as dated rows, replacing the per-participant
  // month-grid calendar (which duplicated the cycle strip + this timeline).
  // Optional so the presentational component stays trivially testable.
  readonly openBarriers?: ReadonlyArray<CaseloadOpenBarrier>;
  readonly stabilityVisit?: CaseloadStabilityVisit | null;
}

// A single dated row in the unified activity timeline. Sends/contacts carry a
// time-of-day (full timestamp); barriers/visit-due are day-grained. `sortMs` is
// the instant the row sorts on (descending: upcoming + newest first); rows with
// no parseable date sink to the bottom.
type TimelineRow =
  | { readonly kind: "send"; readonly sortMs: number; readonly send: OptimisticSend }
  | {
      readonly kind: "contact";
      readonly sortMs: number;
      readonly contact: ParticipantRecentContact;
      readonly key: string;
    }
  | {
      readonly kind: "barrier";
      readonly sortMs: number;
      readonly barrier: CaseloadOpenBarrier;
    }
  | {
      readonly kind: "visit_due";
      readonly sortMs: number;
      readonly ymd: string;
      readonly label: string;
    }
  | {
      readonly kind: "repair";
      readonly sortMs: number;
      readonly repair: OptimisticRepair;
    }
  | {
      readonly kind: "case_note";
      readonly sortMs: number;
      readonly caseNote: OptimisticCaseNote;
    };

// F-07 recent-activity timeline. P3D-01 broadened it from contacts-only to the
// participant's full dated activity (sends, logged contacts, opened barriers,
// next visit-due) so it subsumes the redundant month-grid calendar. The
// PE-rollup "Limited timeline" affordance still keys off `provenance:
// "pe_rollup"` so the SPA tells the truth about the contact-history data gap
// until E-09 (or an IDW_Case_Note__c → PE link) lands.
export function RecentContactsTimeline({
  recentContacts,
  optimisticSends = [],
  repairs = [],
  caseNotes = [],
  openBarriers = [],
  stabilityVisit = null,
}: Props) {
  const hasRollup = recentContacts.some((c) => c.provenance === "pe_rollup");
  const rows = buildTimelineRows({
    recentContacts,
    optimisticSends,
    repairs,
    caseNotes,
    openBarriers,
    stabilityVisit,
  });
  return (
    <section
      aria-labelledby="recent-activity-heading"
      className="rounded-lg border bg-card p-4 shadow-sm"
    >
      <div className="flex items-baseline justify-between gap-2">
        <h2
          id="recent-activity-heading"
          className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
        >
          Recent activity
        </h2>
      </div>
      {rows.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">
          No recent activity logged.
        </p>
      ) : (
        <ol className="mt-3 space-y-2">
          {rows.map((row) => (
            <TimelineRowItem key={rowKey(row)} row={row} />
          ))}
        </ol>
      )}
      {hasRollup && (
        <p role="note" className="mt-3 text-xs text-muted-foreground">
          Showing the latest contact on file. Full history coming soon.
        </p>
      )}
    </section>
  );
}

// Merge every dated activity into one reverse-chronological list. Pure — keeps
// the component a thin renderer over a sorted array.
function buildTimelineRows(input: {
  readonly recentContacts: ReadonlyArray<ParticipantRecentContact>;
  readonly optimisticSends: ReadonlyArray<OptimisticSend>;
  readonly repairs: ReadonlyArray<OptimisticRepair>;
  readonly caseNotes: ReadonlyArray<OptimisticCaseNote>;
  readonly openBarriers: ReadonlyArray<CaseloadOpenBarrier>;
  readonly stabilityVisit: CaseloadStabilityVisit | null;
}): TimelineRow[] {
  const rows: TimelineRow[] = [];

  input.optimisticSends.forEach((send) => {
    rows.push({ kind: "send", send, sortMs: parseMs(send.eventDate ?? send.timestamp) });
  });

  input.repairs.forEach((repair) => {
    rows.push({
      kind: "repair",
      repair,
      sortMs: parseMs(repair.loggedAt),
    });
  });

  input.caseNotes.forEach((caseNote) => {
    rows.push({
      kind: "case_note",
      caseNote,
      sortMs: parseMs(caseNote.loggedAt),
    });
  });

  input.recentContacts.forEach((contact, idx) => {
    rows.push({
      kind: "contact",
      contact,
      key: contact.sfRecordId ?? `${contact.timestamp ?? "unknown"}-${idx}`,
      sortMs: parseMs(contact.timestamp),
    });
  });

  input.openBarriers.forEach((barrier) => {
    rows.push({ kind: "barrier", barrier, sortMs: parseMs(barrier.openedAt) });
  });

  const dueYmd = isoToYmd(input.stabilityVisit?.nextDueDate ?? null);
  if (dueYmd !== null) {
    rows.push({
      kind: "visit_due",
      ymd: dueYmd,
      label: input.stabilityVisit?.statusLabel ?? "Upcoming",
      sortMs: parseMs(dueYmd),
    });
  }

  // Descending by instant; unparseable dates (sortMs === NaN → -Infinity) sink.
  return rows.sort((a, b) => sortValue(b.sortMs) - sortValue(a.sortMs));
}

function parseMs(iso: string | null | undefined): number {
  if (iso === null || iso === undefined || iso === "") return Number.NaN;
  return Date.parse(iso);
}

function sortValue(ms: number): number {
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}

function rowKey(row: TimelineRow): string {
  switch (row.kind) {
    case "send":
      return `send-${row.send.id}`;
    case "contact":
      return `contact-${row.key}`;
    case "barrier":
      return `barrier-${row.barrier.barrierId}`;
    case "visit_due":
      return "visit-due";
    case "repair":
      return `repair-${row.repair.repairId}`;
    case "case_note":
      return `case_note-${row.caseNote.caseNoteId}`;
  }
}

function TimelineRowItem({ row }: { readonly row: TimelineRow }) {
  switch (row.kind) {
    case "send":
      return <SendRow send={row.send} />;
    case "contact":
      return <ContactRow contact={row.contact} />;
    case "barrier":
      return <BarrierRow barrier={row.barrier} />;
    case "visit_due":
      return <VisitDueRow ymd={row.ymd} label={row.label} />;
    case "repair":
      return <RepairRow repair={row.repair} />;
    case "case_note":
      return <CaseNoteRow caseNote={row.caseNote} />;
  }
}

// Collapsed disclosure: shows "Case note logged at <date> · {type}" — never the
// note body. Clicking (or Enter/Space) expands to reveal the note. Mirrors RepairRow.
function CaseNoteRow({ caseNote }: { readonly caseNote: OptimisticCaseNote }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const loggedYmd = isoToYmd(caseNote.loggedAt) ?? caseNote.serviceDate;
  return (
    <li className="rounded-md border border-teal-300/60 bg-teal-50/50 p-3">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
      >
        <span aria-hidden="true" className="text-base leading-none">
          {eventGlyph("case_note")}
        </span>
        <span className="font-medium">
          Case note logged at {formatYmdLong(loggedYmd)}
        </span>
        <span className="text-xs text-muted-foreground">· {caseNote.type}</span>
        <span className="ml-auto text-xs text-muted-foreground">via tool</span>
        <span
          aria-hidden="true"
          className={`text-xs text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`}
        >
          ▶
        </span>
      </button>
      <div id={panelId} hidden={!open} className="mt-2 text-sm">
        <p className="text-xs text-muted-foreground">
          {caseNote.contactType} · {caseNote.status}
        </p>
        <p className="mt-1 whitespace-pre-wrap">{caseNote.note}</p>
      </div>
    </li>
  );
}

// Collapsed disclosure: shows only "Repair logged at <date>" — never the note.
// Clicking (or Enter/Space) expands a panel revealing the note. Mirrors the
// aria-expanded / aria-controls disclosure used by the caseload row.
function RepairRow({ repair }: { readonly repair: OptimisticRepair }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const loggedYmd = isoToYmd(repair.loggedAt) ?? repair.identificationDate;
  return (
    <li className="rounded-md border border-orange-300/60 bg-orange-50/50 p-3">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
      >
        <span aria-hidden="true" className="text-base leading-none">
          {eventGlyph("repair")}
        </span>
        <span className="font-medium">
          Repair logged at {formatYmdLong(loggedYmd)}
        </span>
        <span className="ml-auto text-xs text-muted-foreground">via tool</span>
        <span
          aria-hidden="true"
          className={`text-xs text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`}
        >
          ▶
        </span>
      </button>
      <div id={panelId} hidden={!open} className="mt-2 text-sm">
        <p className="whitespace-pre-wrap">{repair.note}</p>
      </div>
    </li>
  );
}

function SendRow({ send }: { readonly send: OptimisticSend }) {
  return (
    <li className="rounded-md border border-emerald-300/60 bg-emerald-50/60 p-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span aria-hidden="true" className="text-base leading-none">
          {iconForHaystack(send.label)}
        </span>
        <Badge variant="cycleComplete" className="uppercase tracking-wide">
          {send.status}
        </Badge>
        <time dateTime={send.timestamp} className="text-xs text-muted-foreground">
          {formatTimestamp(send.timestamp)}
        </time>
        <span className="ml-auto text-xs text-muted-foreground">via tool</span>
      </div>
      <p className="mt-1 text-sm">
        <span className="font-medium">{send.label}</span>
        {send.summary !== "" && (
          <>
            <span className="text-muted-foreground"> — </span>
            <span>{send.summary}</span>
          </>
        )}
      </p>
    </li>
  );
}

function ContactRow({ contact }: { readonly contact: ParticipantRecentContact }) {
  const status = normalizeStatus(contact.status);
  const provenance =
    contact.provenance === "pe_rollup" ? "via Salesforce" : "via tool";
  return (
    <li className="rounded-md border bg-background p-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span aria-hidden="true" className="text-base leading-none">
          {channelIcon(contact)}
        </span>
        {status !== null && (
          <Badge variant={status.variant} className="uppercase tracking-wide">
            {status.label}
          </Badge>
        )}
        {contact.timestamp !== null && (
          <time
            dateTime={contact.timestamp}
            className="text-xs text-muted-foreground"
          >
            {formatTimestamp(contact.timestamp)}
          </time>
        )}
        <span className="ml-auto text-xs text-muted-foreground">{provenance}</span>
      </div>
      {(contact.caseNoteType !== null || contact.summary !== null) && (
        <p className="mt-1 text-sm">
          {contact.caseNoteType !== null && (
            <span className="font-medium">{contact.caseNoteType}</span>
          )}
          {contact.caseNoteType !== null &&
            contact.summary !== null &&
            contact.summary !== "" && (
              <span className="text-muted-foreground"> — </span>
            )}
          {contact.summary !== null && contact.summary !== "" && (
            <span>{contact.summary}</span>
          )}
        </p>
      )}
    </li>
  );
}

function BarrierRow({ barrier }: { readonly barrier: CaseloadOpenBarrier }) {
  const openedYmd = isoToYmd(barrier.openedAt);
  return (
    <li className="rounded-md border bg-background p-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span aria-hidden="true" className="text-base leading-none">
          {eventGlyph("barrier")}
        </span>
        {barrier.severity !== null && (
          <Badge variant="muted" className="uppercase tracking-wide">
            {barrier.severity} severity
          </Badge>
        )}
        {openedYmd !== null && (
          <span className="text-xs text-muted-foreground">
            {formatYmdLong(openedYmd)}
          </span>
        )}
        <span className="ml-auto text-xs text-muted-foreground">
          via Salesforce
        </span>
      </div>
      <p className="mt-1 text-sm">
        <span className="font-medium">
          {barrier.type !== null ? `Barrier: ${barrier.type}` : "Barrier opened"}
        </span>
      </p>
    </li>
  );
}

function VisitDueRow({
  ymd,
  label,
}: {
  readonly ymd: string;
  readonly label: string;
}) {
  return (
    <li className="rounded-md border border-amber-300/60 bg-amber-50/50 p-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span aria-hidden="true" className="text-base leading-none">
          {eventGlyph("visit_due")}
        </span>
        <Badge variant="muted" className="uppercase tracking-wide">
          {label}
        </Badge>
        <span className="text-xs text-muted-foreground">{formatYmdLong(ymd)}</span>
      </div>
      <p className="mt-1 text-sm">
        <span className="font-medium">Stability visit due</span>
      </p>
    </li>
  );
}

// Channel glyph by free-form caseNoteType / contactType / channel string.
// Matched as lowercase substring so SF label variants ("Stability Meeting",
// "Phone Call", "Outbound SMS") all map without a maintained lookup table.
function channelIcon(c: ParticipantRecentContact): string {
  return channelGlyph(
    classifyContactChannel([c.caseNoteType, c.contactType, c.channel]),
  );
}

// Channel glyph from a free-form label (used for the P1H-11 optimistic-send
// rows, whose label is a single string).
function iconForHaystack(label: string): string {
  return channelGlyph(classifyContactChannel([label]));
}

interface StatusDisplay {
  readonly label: string;
  readonly variant: "muted" | "cycleComplete";
}

// Free-form SF status → "ATTEMPTED" / "COMPLETED". "Complet" matches both
// "Completed" and the British "Complete". Anything else falls through to
// "ATTEMPTED" so the badge slot is always populated when a status exists.
function normalizeStatus(status: string | null): StatusDisplay | null {
  if (status === null || status === "") return null;
  const lower = status.toLowerCase();
  if (lower.includes("complet") || lower.includes("success")) {
    return { label: "Completed", variant: "cycleComplete" };
  }
  return { label: "Attempted", variant: "muted" };
}

// ISO timestamp → short YYYY-MM-DD HH:MM UTC (24h). UTC getters so the same
// instant renders identically across substrates (Vercel region today, Fargate
// region post-cutover) and across any future `"use client"` boundary that
// would otherwise pick up the browser's local time zone.
function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi} UTC`;
}
