"use client";

import type { ReactNode } from "react";
import { ChevronDown, ChevronsUpDown, ChevronUp } from "lucide-react";

import type { CaseloadItem, CaseloadOpenBarrier } from "@anthos/api";

import { cn } from "@/lib/utils";
import { Tooltip } from "@/components/ui/tooltip";

import { queueEmptyState } from "../_lib/queue-empty-states";
import type { SortColumn } from "../_lib/caseload-sort";
import { useCaseloadSort, type AriaSort } from "../_lib/useCaseloadSort";
import { CaseloadRow } from "./CaseloadRow";

interface Props {
  readonly items: ReadonlyArray<CaseloadItem>;
  readonly queueId: string;
  // Gates the per-row Close affordance on open barriers (barrier mutation).
  readonly canMutateBarriers: boolean;
  // Gates the "+" quick action, which now logs a Repair (not a barrier).
  readonly canMutateRepairs: boolean;
  // Gates the 📝 quick action, which logs a general Case Note.
  readonly canLogCaseNotes: boolean;
  // F-08 launcher gate. Stricter than `canMutateBarriers` (Specialist only,
  // per FS v1.12 §F-08 User Permissions lines 845-846); supervisor/VP see
  // the quick actions but not Log Call because the server would 403 on a
  // logged call from either role.
  readonly canLogCalls: boolean;
  readonly pendingParticipantIds: ReadonlySet<string>;
  // F-16 diff indicator. Empty set on initial render; populated by the
  // useRefreshCaseload hook on a successful refresh. The list is just a
  // pass-through — the row applies the visual treatment.
  readonly changedParticipantIds: ReadonlySet<string>;
  // Overrides the queue empty-state copy when set (e.g. a no-match search).
  // Undefined keeps the per-queue empty message (`queueEmptyState`).
  readonly emptyMessage?: ReactNode;
  readonly onAddRepair: (participantId: string) => void;
  readonly onLogCaseNote: (participantId: string) => void;
  readonly onLogCall: (participantId: string) => void;
  readonly onCloseBarrier: (
    participantId: string,
    barrier: CaseloadOpenBarrier,
  ) => void;
}

// P1H-06 — seven-column semantic table matching the 2026-05-25 wireframe
// (BR-23, F-02, AC-12). The `<thead>` is sticky so the column labels stay
// pinned when the row count overflows; the four short columns carry width
// hints from the wireframe so the table doesn't reflow on hover. The
// empty-state path keeps the table shell intact and renders a single
// `colspan=7` row (VR-09: empty is a valid state, not an error).
//
// Sticky + sortable: the wrapper is a bounded scroll region (`max-h` +
// `overflow-y-auto`) so `position: sticky` on the `<th>` actually engages —
// deterministic inside the Salesforce Console iframe, where document-level
// sticky is unreliable. Five columns are user-sortable via `useCaseloadSort`
// (view-layer only; default state preserves the BR-21 server order exactly).
export function CaseloadList({
  items,
  queueId,
  canMutateBarriers,
  canMutateRepairs,
  canLogCaseNotes,
  canLogCalls,
  pendingParticipantIds,
  changedParticipantIds,
  emptyMessage,
  onAddRepair,
  onLogCaseNote,
  onLogCall,
  onCloseBarrier,
}: Props) {
  const { sortedItems, onSortColumn, ariaSortFor, announcement } =
    useCaseloadSort(items);

  return (
    <>
      {/* Polite live region — announces sort changes to screen readers. Sits
          OUTSIDE the scroll container so it is never clipped. */}
      <p
        className="sr-only"
        role="status"
        aria-live="polite"
        data-testid="caseload-sort-status"
      >
        {announcement}
      </p>

      <div
        className="max-h-[calc(100vh-220px)] overflow-y-auto overscroll-contain rounded-2xl border border-zinc-200 shadow-sm"
        data-testid="caseload-scroll"
      >
        <table
          id="caseload-list"
          className="w-full border-collapse"
          data-testid="caseload-list"
        >
          <thead>
            <tr>
              <SortableTh
                column="tier"
                ariaSort={ariaSortFor("tier")}
                onSort={onSortColumn}
                className="w-[110px]"
                tooltip="Priority tier from the scoring engine. Tier 1 (act today) is most urgent, Tier 3 (routine) least."
              >
                Tier
              </SortableTh>
              <SortableTh
                column="participant"
                ariaSort={ariaSortFor("participant")}
                onSort={onSortColumn}
                className="min-w-[180px]"
              >
                Participant
              </SortableTh>
              <Th
                className="min-w-[180px]"
                tooltip="The top factor driving this participant's priority score."
              >
                Why this priority
              </Th>
              <SortableTh
                column="lastContact"
                ariaSort={ariaSortFor("lastContact")}
                onSort={onSortColumn}
                className="w-[90px] max-[900px]:hidden"
                tooltip="Days since the last successful contact was logged."
              >
                Last contact
              </SortableTh>
              <SortableTh
                column="stability"
                ariaSort={ariaSortFor("stability")}
                onSort={onSortColumn}
                className="w-[120px] max-[900px]:hidden"
                tooltip="The four stability-visit checkpoints (90 / 180 / 270 / 365 days). One dot per checkpoint."
              >
                Stability cycle
              </SortableTh>
              <SortableTh
                column="severity"
                ariaSort={ariaSortFor("severity")}
                onSort={onSortColumn}
                className="min-w-[140px]"
                tooltip="Highest-severity open barrier or risk flag on this participant."
              >
                Barriers / tags
              </SortableTh>
              <Th
                className="w-[140px] text-right"
                tooltip="Log a call or add a repair without leaving the list."
              >
                Quick actions
              </Th>
            </tr>
          </thead>
          <tbody>
            {sortedItems.length === 0 ? (
              <tr>
                <td
                  colSpan={7}
                  className="px-4 py-10 text-center text-sm text-muted-foreground"
                  data-testid="caseload-empty"
                >
                  {emptyMessage ?? queueEmptyState(queueId)}
                </td>
              </tr>
            ) : (
              sortedItems.map((item) => (
                <CaseloadRow
                  key={item.participantId}
                  item={item}
                  canMutateBarriers={canMutateBarriers}
                  canMutateRepairs={canMutateRepairs}
                  canLogCaseNotes={canLogCaseNotes}
                  canLogCalls={canLogCalls}
                  isSaving={pendingParticipantIds.has(item.participantId)}
                  isChanged={changedParticipantIds.has(item.participantId)}
                  onAddRepair={onAddRepair}
                  onLogCaseNote={onLogCaseNote}
                  onLogCall={onLogCall}
                  onCloseBarrier={onCloseBarrier}
                />
              ))
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

// Shared sticky-header styling for both sortable and static columns. The
// `shadow` reads as a divider under the pinned header while the body scrolls.
const TH_BASE =
  "sticky top-0 z-10 border-b border-zinc-200 bg-muted/50 px-4 py-2 text-left text-[10px] font-semibold uppercase tracking-[0.5px] text-muted-foreground shadow-[0_1px_0_0_#e4e4e7]";

function Th({
  className,
  children,
  tooltip,
}: {
  readonly className?: string;
  readonly children: ReactNode;
  readonly tooltip?: string;
}) {
  return (
    <th scope="col" className={cn(TH_BASE, className)}>
      {tooltip === undefined ? (
        children
      ) : (
        // `side="bottom"` so the bubble drops into the scroll region instead
        // of being clipped above the sticky header. `focusable={false}` —
        // a static <th> isn't a tab stop and shouldn't become one.
        <Tooltip content={tooltip} side="bottom" focusable={false}>
          {children}
        </Tooltip>
      )}
    </th>
  );
}

function SortableTh({
  column,
  ariaSort,
  onSort,
  className,
  children,
  tooltip,
}: {
  readonly column: SortColumn;
  readonly ariaSort: AriaSort;
  readonly onSort: (column: SortColumn) => void;
  readonly className?: string;
  readonly children: ReactNode;
  readonly tooltip?: string;
}) {
  return (
    <th scope="col" aria-sort={ariaSort} className={cn(TH_BASE, className)}>
      <button
        type="button"
        onClick={() => onSort(column)}
        className={cn(
          "inline-flex items-center gap-1 rounded-sm uppercase tracking-[0.5px] transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          // Active column reads stronger (label + arrow) so the sorted
          // column is obvious at a glance.
          ariaSort !== "none" && "text-foreground",
        )}
        data-testid={`caseload-sort-${column}`}
      >
        {tooltip === undefined ? (
          children
        ) : (
          // The sort <button> is the tab stop; focusin bubbles to the wrapper
          // so the bubble shows on keyboard focus too without a second stop.
          <Tooltip content={tooltip} side="bottom" focusable={false}>
            {children}
          </Tooltip>
        )}
        {/* Fixed-size icon slot so the chevron swap causes no layout shift.
            aria-hidden: the <th aria-sort> is the screen-reader source. */}
        <span
          aria-hidden="true"
          className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center"
        >
          {ariaSort === "ascending" ? (
            <ChevronUp className="h-3.5 w-3.5" strokeWidth={2.5} />
          ) : ariaSort === "descending" ? (
            <ChevronDown className="h-3.5 w-3.5" strokeWidth={2.5} />
          ) : (
            <ChevronsUpDown className="h-3.5 w-3.5 opacity-60" />
          )}
        </span>
      </button>
    </th>
  );
}
