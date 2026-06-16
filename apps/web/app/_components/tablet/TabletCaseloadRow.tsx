"use client";

import Link from "next/link";
import { Fragment, useCallback, useState } from "react";

import type { CaseloadItem, CaseloadOpenBarrier } from "@anthos/api";

import { Button } from "@/components/ui/button";

import { BarrierBadge } from "../participant/BarrierBadge";
import { CycleDots } from "../participant/CycleDots";
import { FactorBreakdownPanel } from "../participant/FactorBreakdownPanel";
import { firingFactorMessage } from "../participant/firing-factor-message";
import { lastContactLabel } from "../participant/last-contact-label";
import { ProgramModifierChip } from "../participant/ProgramModifierChip";
import { QuickActionsRow } from "../participant/QuickActionsRow";
import { SeveritySummaryChip } from "../participant/SeveritySummaryChip";
import { TierPill } from "../participant/TierPill";

interface Props {
  readonly item: CaseloadItem;
  readonly canMutateBarriers: boolean;
  readonly canMutateRepairs: boolean;
  readonly canLogCaseNotes: boolean;
  readonly canLogCalls: boolean;
  readonly isSaving: boolean;
  readonly isChanged: boolean;
  readonly onAddRepair: (participantId: string) => void;
  readonly onLogCaseNote: (participantId: string) => void;
  readonly onLogCall: (participantId: string) => void;
  readonly onCloseBarrier: (
    participantId: string,
    barrier: CaseloadOpenBarrier,
  ) => void;
  readonly onUnSuppress?: (participantId: string) => void;
}

const MS_PER_DAY = 86_400_000;
const MONTH_DAY_FMT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
});

function formatSeenAtLabel(seenAt: string | null): string {
  if (seenAt === null) return "—";
  const d = new Date(seenAt);
  if (Number.isNaN(d.getTime())) return "—";
  return MONTH_DAY_FMT.format(d);
}

function formatSnoozedDuration(seenAt: string | null, now: Date): string {
  if (seenAt === null) return "0d";
  const d = new Date(seenAt);
  if (Number.isNaN(d.getTime())) return "0d";
  const diff = Math.max(0, Math.floor((now.getTime() - d.getTime()) / MS_PER_DAY));
  return `${diff}d`;
}

// P3B-03 — tablet card row. Same data contract as the desktop `CaseloadRow`
// (`apps/web/app/caseload/_components/CaseloadRow.tsx`); behavior parity
// across variants is an explicit ticket AC. The shape diverges: instead of
// a 7-cell `<tr>` competing for a 768px viewport, content stacks vertically
// inside a `<li>` so the F-13 BR-65 portrait-fit constraint holds without
// truncating tier, why-line, or quick actions. Touch targets reach the F-13
// AC-48 floor via `QuickActionsRow variant="tablet"` (h-11 / 44px).
//
// Whole-card navigation mirrors the desktop row: the entire card is the
// primary tap target and opens /participants/[id] (BR-41) via the inner
// `Link`'s stretched `::before` overlay anchored to the positioned `<li>`.
// There is no card-level tap handler; the disclosure button (sole expand
// control), QuickActionsRow buttons, and un-snooze button get `relative z-10`
// to sit above the overlay. The factor-breakdown panel renders as a sibling
// inside the same `<li>` rather than a colspan row.
export function TabletCaseloadRow({
  item,
  canMutateBarriers,
  canMutateRepairs,
  canLogCaseNotes,
  canLogCalls,
  isSaving,
  isChanged,
  onAddRepair,
  onLogCaseNote,
  onLogCall,
  onCloseBarrier,
  onUnSuppress,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const breakdownId = `breakdown-tablet-${item.participantId}`;
  const openBarriers = item.openBarriers ?? [];
  const hasOpenBarriers = openBarriers.length > 0;
  const tags = item.tags ?? [];
  const perCheckpointBreakdown = item.perCheckpointBreakdown ?? [];
  const displayLabel = item.displayName ?? item.participantId;
  const primaryLabel = firingFactorMessage({
    highestImpactFactor: item.highestImpactFactor,
    factors: item.factors,
    triggeredInvariants: item.triggered_invariants,
  });
  const peMetaParts = [item.peLabel, item.programCode].filter(
    (v): v is string => typeof v === "string" && v.length > 0,
  );
  if (typeof item.aftercareDay === "number") {
    peMetaParts.push(`Day ${item.aftercareDay}`);
  }
  const peMeta = peMetaParts.join(" · ");

  const toggleExpanded = useCallback(() => setExpanded((v) => !v), []);

  const suppression = item.pathCSuppression ?? null;
  const isSuppressed = suppression?.active === true;

  const cardClasses = isChanged
    ? "relative cursor-pointer rounded-xl border border-zinc-100/60 border-l-4 border-l-amber-400 bg-amber-50/60 p-4 transition-colors duration-150 hover:bg-amber-100/60 active:bg-amber-100"
    : "relative cursor-pointer rounded-xl border border-zinc-100/60 bg-background p-4 transition-colors duration-150 hover:bg-zinc-50/70 active:bg-zinc-100/70";

  return (
    <li
      className={cardClasses}
      data-testid="caseload-row"
      data-variant="tablet"
      data-changed={isChanged ? "true" : undefined}
    >
      <div className="flex items-start gap-3">
        <div className="shrink-0">
          {isSuppressed ? (
            <span
              data-testid="caseload-row-snoozed-pill"
              className="inline-flex items-center gap-1 rounded-full bg-violet-50 px-2.5 py-1 text-xs font-medium text-violet-800 ring-1 ring-inset ring-violet-200"
            >
              <span aria-hidden="true">⏸</span>
              Snoozed: {formatSnoozedDuration(suppression?.seenAt ?? null, new Date())}
            </span>
          ) : (
            <TierPill tier={item.tier} />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-baseline gap-2">
            <Link
              href={`/participants/${item.participantId}`}
              className="block truncate text-base font-semibold text-foreground hover:underline focus-visible:outline-none before:absolute before:inset-0 before:content-[''] before:rounded-xl focus-visible:before:ring-2 focus-visible:before:ring-inset focus-visible:before:ring-ring"
              aria-label={`Open detail view for ${displayLabel}`}
            >
              {item.displayName === null ? (
                <span className="font-mono text-sm">{item.participantId}</span>
              ) : (
                item.displayName
              )}
            </Link>
            {item.aftercareExtended && <ProgramModifierChip />}
          </div>
          {peMeta.length > 0 && (
            <div className="mt-0.5 truncate text-xs text-muted-foreground">
              {peMeta}
            </div>
          )}
        </div>
      </div>

      {isSuppressed ? (
        <div
          className="mt-3 min-w-0"
          data-testid="caseload-row-suppression-treatment"
        >
          <div className="truncate text-sm font-medium text-violet-900">
            Seen by Other Provider on {formatSeenAtLabel(suppression?.seenAt ?? null)}
          </div>
          <div className="mt-0.5 truncate text-xs text-muted-foreground">
            Suppression active · tap to un-snooze
          </div>
        </div>
      ) : (
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={breakdownId}
          aria-label="Show priority breakdown"
          onClick={toggleExpanded}
          className="relative z-10 mt-3 block w-full min-w-0 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          data-testid="caseload-row-disclosure"
        >
          <div className="text-sm text-foreground">{primaryLabel}</div>
          {item.secondaryFactorLabel !== null && (
            <div className="mt-0.5 text-xs text-muted-foreground">
              {item.secondaryFactorLabel}
            </div>
          )}
        </button>
      )}

      <div className="mt-3 flex items-center gap-3 text-xs text-muted-foreground">
        <span className="tabular-nums">
          {lastContactLabel(item.lastSuccessfulContactDaysAgo)}
        </span>
        <span aria-hidden="true">·</span>
        <CycleDots perCheckpointBreakdown={perCheckpointBreakdown} />
      </div>

      {tags.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-1">
          <SeveritySummaryChip
            tags={tags}
            expanded={expanded}
            onToggle={toggleExpanded}
            controlsId={breakdownId}
          />
        </div>
      )}

      <div className="mt-3 flex items-center justify-between gap-3">
        {isSaving ? (
          <p
            role="status"
            aria-live="polite"
            className="text-xs italic text-muted-foreground"
          >
            Saving…
          </p>
        ) : (
          <span />
        )}
        {isSuppressed ? (
          <button
            type="button"
            data-testid="caseload-row-un-snooze"
            aria-label="Un-snooze: clear Path C suppression"
            disabled={onUnSuppress === undefined}
            onClick={() => onUnSuppress?.(item.participantId)}
            className="relative z-10 inline-flex h-11 w-11 items-center justify-center rounded-md border border-input bg-background text-base hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span aria-hidden="true">▶</span>
          </button>
        ) : (
          <QuickActionsRow
            participantId={item.participantId}
            canLogCalls={canLogCalls}
            canMutateRepairs={canMutateRepairs}
            canLogCaseNotes={canLogCaseNotes}
            onLogCall={onLogCall}
            onAddRepair={onAddRepair}
            onLogCaseNote={onLogCaseNote}
            variant="tablet"
            className="relative z-10"
          />
        )}
      </div>

      {expanded && (
        <Fragment>
          {canMutateBarriers && hasOpenBarriers && (
            <OpenBarriersList
              barriers={openBarriers}
              onClose={(barrier) => onCloseBarrier(item.participantId, barrier)}
            />
          )}
          <div
            id={breakdownId}
            data-testid="factor-breakdown-row"
            className="mt-3 rounded-md bg-muted/30"
          >
            <FactorBreakdownPanel
              factors={item.factors}
              triggeredInvariants={item.triggered_invariants}
              tags={tags}
            />
          </div>
        </Fragment>
      )}
    </li>
  );
}

function OpenBarriersList({
  barriers,
  onClose,
}: {
  readonly barriers: ReadonlyArray<CaseloadOpenBarrier>;
  readonly onClose: (barrier: CaseloadOpenBarrier) => void;
}) {
  return (
    <div className="mt-3 space-y-2 rounded-md bg-muted/30 px-3 py-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Open Barriers
      </h3>
      <ul className="space-y-1">
        {barriers.map((b) => (
          <li
            key={b.barrierId}
            className="flex items-center justify-between gap-2 rounded-md border bg-background px-3 py-2"
          >
            <BarrierBadge barrier={b} />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                onClose(b);
              }}
            >
              Close
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
