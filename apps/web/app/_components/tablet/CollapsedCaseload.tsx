import Link from "next/link";

import type { CaseloadItem } from "@anthos/api";

import { firingFactorMessage } from "../participant/firing-factor-message";

import {
  DEMO_CASELOAD_TOTAL_FALLBACK,
  DEMO_TODAYS_CASELOAD_FALLBACK,
  type DemoCaseloadFallbackRow,
} from "./_demo/fixtures";

// "Today's caseload (3 of N shown)" mini-list. Renders the top three real
// `CaseloadItem`s from F-02 when available; falls back to demo fixtures so
// the page never goes visually blank during stakeholder walkthroughs.
//
// Each row links to the existing `/participants/[id]` detail route (BR-41);
// the footer link bridges to the full desktop-style `/caseload` route.

interface Props {
  // Pre-truncated to ≤3 by the caller; we display whatever comes in.
  readonly items: ReadonlyArray<CaseloadItem>;
  // Authoritative total from the F-02 envelope (or 0 if unauthenticated /
  // empty — falls back to the demo total to keep the "N shown" caption sane).
  readonly totalCount: number;
  // P3C-14 — when provided (and the role allows it), each REAL row gets a 📝
  // Log Case Note quick action wired here, so the offline-first case-note flow
  // is reachable on the tablet landing where the Pending Sync panel lives. The
  // demo fixtures never get the action (their ids aren't real PEs).
  readonly canLogCaseNote?: boolean;
  readonly onLogCaseNote?: (participantId: string) => void;
}

interface NormalisedRow {
  readonly participantId: string;
  readonly displayName: string;
  readonly firingReason: string;
}

function normaliseRealItem(item: CaseloadItem): NormalisedRow {
  const displayName = item.displayName ?? item.participantId;
  const firingReason = firingFactorMessage({
    highestImpactFactor: item.highestImpactFactor,
    factors: item.factors,
    triggeredInvariants: item.triggered_invariants,
  });
  return {
    participantId: item.participantId,
    displayName,
    firingReason,
  };
}

function normaliseDemoItem(row: DemoCaseloadFallbackRow): NormalisedRow {
  return {
    participantId: row.participantId,
    displayName: row.displayName,
    firingReason: row.firingReason,
  };
}

export function CollapsedCaseload({
  items,
  totalCount,
  canLogCaseNote = false,
  onLogCaseNote,
}: Props) {
  const usingRealData = items.length > 0;
  const rows: ReadonlyArray<NormalisedRow> = usingRealData
    ? items.slice(0, 3).map(normaliseRealItem)
    : DEMO_TODAYS_CASELOAD_FALLBACK.map(normaliseDemoItem);
  const displayedTotal =
    totalCount > 0 ? totalCount : DEMO_CASELOAD_TOTAL_FALLBACK;
  // Only real rows get the write action — fixture ids aren't real PEs.
  const showCaseNoteAction =
    usingRealData && canLogCaseNote && onLogCaseNote !== undefined;

  return (
    <section
      className="mx-4 mb-4 rounded-lg border border-zinc-200 bg-white p-3.5"
      data-testid="collapsed-caseload"
      data-using-real-data={usingRealData ? "true" : "false"}
    >
      <h2 className="mb-3 text-[13px] font-bold text-tabletPrimary">
        Today&apos;s caseload ({rows.length} of {displayedTotal} shown)
      </h2>
      <ul className="flex flex-col">
        {rows.map((row) => (
          <li
            key={row.participantId}
            className="flex items-center gap-2.5 border-b border-zinc-100 py-2.5 text-xs last:border-b-0"
          >
            <div className="flex-1 min-w-0">
              <p className="truncate font-semibold text-tabletPrimary">
                {row.displayName}
              </p>
              <p className="truncate text-[11px] text-zinc-500">
                {row.firingReason}
              </p>
            </div>
            {showCaseNoteAction && (
              <button
                type="button"
                onClick={() => onLogCaseNote?.(row.participantId)}
                title="Log note"
                aria-label={`Log note for ${row.displayName}`}
                data-testid="collapsed-caseload-log-case-note"
                className="inline-flex h-11 w-11 items-center justify-center rounded-md text-base hover:bg-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                📝
              </button>
            )}
            <Link
              href={`/participants/${row.participantId}`}
              className="rounded-md bg-tabletPrimary px-3.5 py-2 text-[11px] font-semibold text-white hover:bg-tabletPrimaryDeep"
            >
              Open
            </Link>
          </li>
        ))}
      </ul>
      <Link
        href="/caseload"
        className="mt-3 block text-center text-xs font-medium text-tabletPrimary hover:underline"
      >
        View full caseload →
      </Link>
    </section>
  );
}
