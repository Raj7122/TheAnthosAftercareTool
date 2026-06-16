import type {
  CaseloadCycleStatus,
  PerAnchorState,
  PerCheckpointBreakdownDto,
} from "@anthos/api";

import { Tooltip } from "@/components/ui/tooltip";

interface Props {
  readonly breakdown: ReadonlyArray<PerCheckpointBreakdownDto>;
  // ISO date string (YYYY-MM-DD) for the aftercare start. Used to derive a
  // calendar date label for each anchor (start + anchor days). Null hides
  // the date sub-label so the timeline still renders for participants whose
  // start date hasn't been hydrated.
  readonly aftercareStartDate: string | null;
  // Cycle posture summary line under the timeline (next-due days, completed
  // count). Pulled straight from `body.cycleStatus`.
  readonly cycleStatus: CaseloadCycleStatus;
}

// F-05 BR-33 P1F-07 cycle breakdown — 2026-05-25 wireframe rewrite from a
// vertical list to a horizontal timeline. The four anchors (90/180/270/365)
// render as nodes connected by a progress line; node colors map to the same
// BR-33 five-state palette (`cycleComplete/Due/Overdue/CatchUp` / muted for
// future). Domain guarantees ascending anchor order; SPA renders without
// re-sorting.
//
// Calendar dates beneath each node are derived from `aftercareStartDate +
// anchor days` (rounded to local-date arithmetic), not from the per-anchor
// snapshot — the breakdown DTO carries only state, not service dates, and
// the BR-25 stability-meeting credit story is on a separate ticket.
export function CycleBreakdownPanel({
  breakdown,
  aftercareStartDate,
  cycleStatus,
}: Props) {
  if (breakdown.length === 0) {
    return (
      <section
        aria-labelledby="cycle-breakdown-heading"
        className="rounded-lg border bg-card p-4 shadow-sm"
      >
        <h2
          id="cycle-breakdown-heading"
          className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
        >
          Stability visit cycle
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">Not in cycle.</p>
      </section>
    );
  }
  const summary = formatCycleSummary(cycleStatus, breakdown);
  return (
    <section
      aria-labelledby="cycle-breakdown-heading"
      className="rounded-lg border bg-card p-4 shadow-sm"
    >
      <h2
        id="cycle-breakdown-heading"
        className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
      >
        Stability visit cycle
      </h2>
      <ol className="mt-4 flex items-start justify-between gap-2">
        {breakdown.map((row, idx) => {
          const isLast = idx === breakdown.length - 1;
          const dateLabel = anchorDateLabel(aftercareStartDate, row.anchor);
          return (
            <li
              key={row.anchor}
              className="relative flex flex-1 flex-col items-center"
            >
              {!isLast && (
                // Decorative connector — pointer-events-none so it never
                // intercepts hover meant for the checkpoint beneath it.
                <span
                  aria-hidden="true"
                  className={`pointer-events-none absolute left-1/2 top-3 h-0.5 w-full ${
                    row.state === "complete" ? "bg-cycleComplete" : "bg-border"
                  }`}
                />
              )}
              {/* Whole checkpoint (dot + day + date) is the hover/focus target
                  — a 24px dot alone is too small to reliably trigger. `z-10`
                  lifts it above the connector line. */}
              <Tooltip
                content={anchorTooltip(row.anchor, row.state)}
                className="relative z-10 flex-col items-center"
              >
                <span
                  aria-label={`${row.anchor}-day visit: ${anchorAria(row.state)}`}
                  className={`flex h-6 w-6 items-center justify-center rounded-full border-2 border-background ${nodeColor(row.state)}`}
                >
                  {row.state === "complete" && (
                    <span aria-hidden="true" className="text-[10px] font-bold text-white">
                      ✓
                    </span>
                  )}
                </span>
                <span className="mt-2 text-xs font-medium">{row.anchor}d</span>
                {dateLabel !== null && (
                  <span className="text-[11px] text-muted-foreground">
                    {dateLabel}
                  </span>
                )}
              </Tooltip>
            </li>
          );
        })}
      </ol>
      {summary !== null && (
        <p
          className={`mt-4 text-sm ${cycleStatus.state === "overdue" ? "font-medium text-cycleOverdue" : "text-muted-foreground"}`}
        >
          {summary}
        </p>
      )}
    </section>
  );
}

function nodeColor(state: PerAnchorState): string {
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
      return "bg-background ring-2 ring-inset ring-border";
  }
}

// Plain-language hover copy for a checkpoint node — definition + the action
// the state implies (mirrors the per-dot semantics in `cycle-dot-variant.ts`).
function anchorTooltip(anchor: number, state: PerAnchorState): string {
  switch (state) {
    case "complete":
      return `${anchor}-day stability visit completed.`;
    case "due":
      return `${anchor}-day stability visit due soon — schedule it.`;
    case "overdue":
      return `${anchor}-day stability visit overdue — schedule a make-up.`;
    case "catch_up":
      return `${anchor}-day visit missed — catch-up window still open.`;
    case "future":
      return `${anchor}-day stability visit not yet due.`;
  }
}

function anchorAria(state: PerAnchorState): string {
  switch (state) {
    case "complete":
      return "Complete";
    case "due":
      return "Due";
    case "overdue":
      return "Overdue";
    case "catch_up":
      return "Catch-up";
    case "future":
      return "Future";
  }
}

// Renders e.g. "7/15/25" from a YYYY-MM-DD start + anchor offset. Returns
// null when the start date is missing or unparseable.
function anchorDateLabel(
  aftercareStartDate: string | null,
  anchor: number,
): string | null {
  if (aftercareStartDate === null) return null;
  const startMs = Date.parse(aftercareStartDate);
  if (Number.isNaN(startMs)) return null;
  const target = new Date(startMs + anchor * 86400000);
  const m = target.getUTCMonth() + 1;
  const d = target.getUTCDate();
  const y = target.getUTCFullYear() % 100;
  return `${m}/${d}/${String(y).padStart(2, "0")}`;
}

// Composes the under-timeline summary sentence.
function formatCycleSummary(
  cycleStatus: CaseloadCycleStatus,
  breakdown: ReadonlyArray<PerCheckpointBreakdownDto>,
): string | null {
  const completed = breakdown.filter((b) => b.state === "complete").length;
  const total = breakdown.length;
  let leadingSentence: string | null = null;
  if (cycleStatus.state === "overdue" && cycleStatus.daysOverdue > 0) {
    leadingSentence = `Checkpoint overdue by ${cycleStatus.daysOverdue} day${cycleStatus.daysOverdue === 1 ? "" : "s"}.`;
  } else if (
    cycleStatus.state === "due" &&
    cycleStatus.daysToNext !== null
  ) {
    leadingSentence = `Next checkpoint due in ${cycleStatus.daysToNext} day${cycleStatus.daysToNext === 1 ? "" : "s"}.`;
  } else if (cycleStatus.state === "catch_up") {
    leadingSentence = "Catch-up window open.";
  }
  const completedSentence = `${completed} of ${total} completed.`;
  if (leadingSentence === null) return completedSentence;
  return `${leadingSentence} ${completedSentence}`;
}
