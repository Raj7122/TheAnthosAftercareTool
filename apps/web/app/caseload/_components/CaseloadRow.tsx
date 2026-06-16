"use client";

import Link from "next/link";
import { Fragment, useCallback, useState } from "react";

import type { CaseloadItem, CaseloadOpenBarrier } from "@anthos/api";

import { Button } from "@/components/ui/button";

import { useConnectivity } from "../../_lib/connectivity/context";
import { BarrierBadge } from "../../_components/participant/BarrierBadge";
import { CycleDots } from "../../_components/participant/CycleDots";
import { FactorBreakdownPanel } from "../../_components/participant/FactorBreakdownPanel";
import { firingFactorMessage } from "../../_components/participant/firing-factor-message";
import { lastContactLabel } from "../../_components/participant/last-contact-label";
import { ProgramModifierChip } from "../../_components/participant/ProgramModifierChip";
import { QuickActionsRow } from "../../_components/participant/QuickActionsRow";
import { SeveritySummaryChip } from "../../_components/participant/SeveritySummaryChip";
import { TierPill } from "../../_components/participant/TierPill";

interface Props {
  readonly item: CaseloadItem;
  // Gates the per-row Close affordance on open barriers (barrier mutation).
  readonly canMutateBarriers: boolean;
  // Gates the "+" quick action, which now logs a Repair (not a barrier).
  readonly canMutateRepairs: boolean;
  // Gates the 📝 quick action, which logs a general Case Note.
  readonly canLogCaseNotes: boolean;
  // F-08 Log-a-Call launcher gate. Stricter than `canMutateBarriers` per FS
  // v1.12 §F-08 User Permissions (lines 845-846: Specialist-only write).
  readonly canLogCalls: boolean;
  // Pattern A "Saving…" row-level indicator. Owned by
  // `useCaseloadMutations`; the row renders the affordance only.
  readonly isSaving: boolean;
  // F-16 diff indicator. Sustained left-border accent + tinted background
  // until the next refresh or queue switch. Carries no PII — derived from
  // the participantId's membership in the changed-set.
  readonly isChanged: boolean;
  readonly onAddRepair: (participantId: string) => void;
  readonly onLogCaseNote: (participantId: string) => void;
  readonly onLogCall: (participantId: string) => void;
  readonly onCloseBarrier: (
    participantId: string,
    barrier: CaseloadOpenBarrier,
  ) => void;
  // P1H-10 — Path C suppression un-snooze handler. Optional: the row reads
  // `item.pathCSuppression?.active` to decide whether to render the un-snooze
  // affordance at all, so callers that haven't wired the mutation can omit
  // this prop. Today `pathCSuppression` is always null at the DTO layer
  // (Pattern F stub, BR-21 unratified), so this branch is dead code in
  // practice — the prop is in place so P1H-10b can light it up by changing
  // the DTO projection alone.
  readonly onUnSuppress?: (participantId: string) => void;
}

const MS_PER_DAY = 86_400_000;
const MONTH_DAY_FMT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
});

// "Apr 25" — the wireframe's purple primary line ("Seen by Other Provider
// on {date}"). Falls back to "—" when the wire shape carries no `seenAt`.
function formatSeenAtLabel(seenAt: string | null): string {
  if (seenAt === null) return "—";
  const d = new Date(seenAt);
  if (Number.isNaN(d.getTime())) return "—";
  return MONTH_DAY_FMT.format(d);
}

// "11d" — whole days since `seenAt`. Negative or NaN collapses to "0d" so
// the badge always reads cleanly even on clock skew between server + client.
function formatSnoozedDuration(seenAt: string | null, now: Date): string {
  if (seenAt === null) return "0d";
  const d = new Date(seenAt);
  if (Number.isNaN(d.getTime())) return "0d";
  const diff = Math.max(0, Math.floor((now.getTime() - d.getTime()) / MS_PER_DAY));
  return `${diff}d`;
}

// P1H-06 — seven-column caseload row, now `<tr>` + `<td>` inside the parent
// `<table>` (P1H-05 left the markup swap deferred to this ticket). The row
// returns a fragment so it can emit two siblings into `<tbody>`: the data
// row plus, when expanded, the BR-19 factor-breakdown row as a full-width
// (`colspan=7`) sibling instead of a div nested inside the data row.
//
// Whole-row navigation: the entire row is the primary click target and
// opens the BR-41 participant detail view. There is no JS row handler —
// the participant-name `<Link>` carries a stretched `::before` overlay
// (`before:absolute before:inset-0`) anchored to the positioned `<tr>`,
// so a click anywhere on the row activates that link. Interactive controls
// (the WHY THIS PRIORITY disclosure, QuickActionsRow buttons, the un-snooze
// button) get `relative z-10` to paint above the transparent overlay and
// stay independently clickable.
//
// Disclosure pattern: the WHY THIS PRIORITY cell is a real `<button>`
// carrying `aria-expanded` + `aria-controls` — the keyboard-accessible
// disclosure widget and the sole control that expands the BR-19 factor
// breakdown (row-click no longer toggles it).
export function CaseloadRow({
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
  const breakdownId = `breakdown-${item.participantId}`;
  // Defensive against undefined: rolling-deploy cache rows may lack the
  // post-P1H-03 fields. Treat missing arrays as empty.
  const openBarriers = item.openBarriers ?? [];
  const hasOpenBarriers = openBarriers.length > 0;
  const tags = item.tags ?? [];
  const perCheckpointBreakdown = item.perCheckpointBreakdown ?? [];
  const displayLabel = item.displayName ?? item.participantId;
  // P1H-13b — value-bearing sentence (e.g., "Hasn't been reached in 12 days")
  // replaces `primaryFactorLabel`'s axis-only output for the F-02 row.
  // `primary-factor.ts` is unchanged and still serves the ParticipantDetailBody
  // + calibration twin per the EC-12 parity contract.
  const primaryLabel = firingFactorMessage({
    highestImpactFactor: item.highestImpactFactor,
    factors: item.factors,
    triggeredInvariants: item.triggered_invariants,
  });
  // Defensive against undefined: a cached row written before P1H-01 lands
  // the PE meta fields will deserialize without these keys. Treat anything
  // that isn't a non-empty string as "no value" rather than crashing on
  // `.length`.
  const peMetaParts = [item.peLabel, item.programCode].filter(
    (v): v is string => typeof v === "string" && v.length > 0,
  );
  if (typeof item.aftercareDay === "number") {
    peMetaParts.push(`Day ${item.aftercareDay}`);
  }
  const peMeta = peMetaParts.join(" · ");

  const toggleExpanded = useCallback(() => setExpanded((v) => !v), []);

  // P3C-03 — desktop iframe surface: visibly disable the un-snooze button
  // when the BFF heartbeat fails or `navigator.onLine === false`
  // (TR-OFFLINE-2 / BR-67). On the tablet PWA surface the provider keeps
  // state pinned at "online", so this OR collapses to the existing logic.
  const connectivity = useConnectivity();
  const writesBlocked = connectivity === "degraded";

  // P1H-10 — Path C suppression render gate. Today `item.pathCSuppression`
  // is always `null` at the DTO layer (Pattern F stub; BR-21 / GAP-9
  // unratified, upstream detection ticket not built), so `isSuppressed` is
  // always `false` and all three render branches below are dead code.
  // Wired so the day the DTO projection lands real data — and the
  // configuration's `sbop_enabled` flag flips — no SPA change is required.
  const suppression = item.pathCSuppression ?? null;
  const isSuppressed = suppression?.active === true;

  // Amber palette stays inside the existing Tailwind tokens; deliberately
  // not red (would read as an error state) and not the primary accent.
  // `relative` anchors the participant-name link's stretched ::before overlay
  // (the whole-row navigation target) to the <tr>, not its <td>. The active:
  // state gives an immediate pressed cue when the row is clicked.
  const rowClasses = isChanged
    ? "relative cursor-pointer border-b border-zinc-200 border-l-4 border-l-amber-400 bg-amber-50/60 transition-colors duration-150 hover:bg-amber-100/60 active:bg-amber-100"
    : "relative cursor-pointer border-b border-zinc-200 transition-colors duration-150 hover:bg-zinc-50/70 active:bg-zinc-100/70";

  return (
    <Fragment>
      <tr
        className={rowClasses}
        data-testid="caseload-row"
        data-changed={isChanged ? "true" : undefined}
      >
        <td className="px-4 py-3 align-middle">
          {isSuppressed ? (
            // P1H-10 — wireframe row 7 (Naomi Carter, line 2552): purple
            // "⏸ Snoozed: Xd" pill REPLACES the tier glyph while suppression
            // is active. The engine's `item.tier` is untouched (Pattern F:
            // render-only overlay, not an engine output) so the day the
            // suppression clears the tier pill returns without a recompute.
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
        </td>
        <td className="min-w-0 px-4 py-3 align-middle">
          {/*
            P1H-14: PARTICIPANT cell — displayName + optional Aftercare
            Extended modifier chip sit on the same baseline. `min-w-0` lets
            the Link's `truncate` keep working inside the flex; the chip
            stays its intrinsic small width and doesn't compete for room.
            The chip is rendered HERE (not in the TAGS cluster) per the
            wireframe — see Decision #1 in the P1H-14 plan.
          */}
          <div className="flex min-w-0 items-baseline gap-2">
            <Link
              href={`/participants/${item.participantId}`}
              className="block truncate text-sm font-semibold text-foreground hover:underline focus-visible:outline-none before:absolute before:inset-0 before:content-[''] before:rounded-sm focus-visible:before:ring-2 focus-visible:before:ring-inset focus-visible:before:ring-ring"
              aria-label={`Open detail view for ${displayLabel}`}
            >
              {item.displayName === null ? (
                <span className="font-mono text-xs">{item.participantId}</span>
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
          {/*
            F-13 tablet collapse: at <900px the Last contact and Stability
            cycle columns hide; project their values inline under PARTICIPANT
            so the specialist still sees them.
          */}
          <div className="mt-0.5 hidden items-center gap-2 text-xs text-muted-foreground max-[900px]:flex">
            <span className="tabular-nums">
              {lastContactLabel(item.lastSuccessfulContactDaysAgo)}
            </span>
            <span aria-hidden="true">·</span>
            <CycleDots perCheckpointBreakdown={perCheckpointBreakdown} />
          </div>
          {isSaving && (
            <p
              role="status"
              aria-live="polite"
              className="text-xs italic text-muted-foreground"
            >
              Saving…
            </p>
          )}
        </td>
        <td className="min-w-0 px-4 py-3 align-middle">
          {isSuppressed ? (
            // P1H-10 — wireframe row 7 (Naomi Carter, lines 2558-2559):
            // purple primary line "Seen by Other Provider on {date}" +
            // muted secondary "Suppression active · tap to un-snooze".
            // Replaces the priority-breakdown disclosure while suppressed —
            // the engine factors are still there, just not the headline.
            <div
              className="block w-full min-w-0 text-left"
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
              className="relative z-10 block w-full min-w-0 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              data-testid="caseload-row-disclosure"
            >
              <div className="truncate text-sm text-foreground">
                {primaryLabel}
              </div>
              {item.secondaryFactorLabel !== null && (
                <div className="mt-0.5 truncate text-xs text-muted-foreground">
                  {item.secondaryFactorLabel}
                </div>
              )}
            </button>
          )}
        </td>
        <td className="px-4 py-3 align-middle text-sm tabular-nums text-muted-foreground max-[900px]:hidden">
          {lastContactLabel(item.lastSuccessfulContactDaysAgo)}
        </td>
        <td className="px-4 py-3 align-middle max-[900px]:hidden">
          <CycleDots perCheckpointBreakdown={perCheckpointBreakdown} />
        </td>
        <td className="min-w-0 px-4 py-3 align-middle">
          {tags.length === 0 ? (
            <span className="text-xs text-muted-foreground">—</span>
          ) : (
            <SeveritySummaryChip
              tags={tags}
              expanded={expanded}
              onToggle={toggleExpanded}
              controlsId={breakdownId}
            />
          )}
        </td>
        <td className="px-4 py-3 align-middle text-right">
          {isSuppressed ? (
            // P1H-10 — wireframe row 7 (Naomi Carter, line 2577): the
            // un-snooze button (▶) replaces the call/email quick-actions
            // cluster while suppression is active. Wired through
            // `onUnSuppress`; when the caller hasn't wired it, the button
            // is disabled so the affordance still reads but cannot misfire.
            <button
              type="button"
              data-testid="caseload-row-un-snooze"
              aria-label={
                writesBlocked
                  ? "Un-snooze (Offline — Write Access Suspended)"
                  : "Un-snooze: clear Path C suppression"
              }
              title={writesBlocked ? "Offline — Write Access Suspended" : undefined}
              disabled={onUnSuppress === undefined || writesBlocked}
              onClick={() => onUnSuppress?.(item.participantId)}
              className="relative z-10 inline-flex h-8 w-8 items-center justify-center rounded-md border border-input bg-background text-sm hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
              className="relative z-10"
            />
          )}
        </td>
      </tr>
      {expanded && (
        <tr data-testid="factor-breakdown-row">
          <td
            id={breakdownId}
            colSpan={7}
            className="border-b bg-muted/30 p-0"
          >
            {canMutateBarriers && hasOpenBarriers && (
              <OpenBarriersList
                barriers={openBarriers}
                onClose={(barrier) =>
                  onCloseBarrier(item.participantId, barrier)
                }
              />
            )}
            <FactorBreakdownPanel
              factors={item.factors}
              triggeredInvariants={item.triggered_invariants}
              tags={tags}
            />
          </td>
        </tr>
      )}
    </Fragment>
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
    <div className="space-y-2 border-b bg-muted/30 px-4 py-3">
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
              onClick={() => onClose(b)}
            >
              Close
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
