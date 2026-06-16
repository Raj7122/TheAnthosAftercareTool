import { memo } from "react";

import type { RowTag } from "@anthos/api";

import { Tooltip } from "@/components/ui/tooltip";

import { severitySummary, type SeverityLevel } from "./severity-summary";

interface Props {
  readonly tags: ReadonlyArray<RowTag>;
  // Mirrors the row's disclosure state — the chip is a second control pointing
  // at the same expanded factor-breakdown region as the "Why this priority"
  // cell, so it shares `expanded` / `onToggle` / `controlsId`.
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly controlsId: string;
}

// Subtle palette per the ticket ("danger/warning/neutral-subtle" — background
// soft, text strong). Follows the `programModifier` Badge precedent of raw
// Tailwind soft pills rather than the solid `bg-barrierHigh` chips, so severity
// reads as the dominant-but-calm signal and color competition drops. `glyph` is
// a colored circle — shape conveys severity without relying on color alone
// (accessibility AC). Switch form mirrors `tag-chip-variant.ts` (warning-free
// vs. a keyed-record lookup, which trips `security/detect-object-injection`).
// `classes` styles the pill (soft bg + strong text + ring); `badge` styles the
// trailing count pill-badge one shade deeper so the number reads as a distinct
// token. `glyph` is a colored circle — shape conveys severity without relying
// on color alone (accessibility AC).
function levelStyle(level: SeverityLevel): {
  readonly classes: string;
  readonly badge: string;
  readonly glyph: string;
} {
  switch (level) {
    case "critical":
      return {
        classes: "bg-red-50 text-red-700 ring-red-200",
        badge: "bg-red-100 text-red-700",
        glyph: "🔴",
      };
    case "attention":
      return {
        classes: "bg-amber-50 text-amber-700 ring-amber-200",
        badge: "bg-amber-100 text-amber-700",
        glyph: "🟠",
      };
    case "monitor":
      return {
        classes: "bg-zinc-50 text-zinc-600 ring-zinc-200",
        badge: "bg-zinc-200 text-zinc-700",
        glyph: "🟡",
      };
  }
}

// F-02 caseload row — single severity summary that replaces the multi-chip
// "Barriers / tags" cluster. The detailed chips remain available in the
// expanded breakdown (FactorBreakdownPanel `tags`); this chip is the collapsed
// headline and the second disclosure control for that region.
//
// Returns `null` for an unflagged row (no tags) so the caller's existing
// "—" empty-state shows — clean rows stay quiet (clutter reduction).
function SeveritySummaryChipImpl({ tags, expanded, onToggle, controlsId }: Props) {
  if (tags.length === 0) return null;

  const { level, label, issueCount } = severitySummary(tags);
  const issueWord = issueCount === 1 ? "issue" : "issues";
  const { classes, badge, glyph } = levelStyle(level);

  return (
    // `relative z-10` lifts the trigger (and its hover area) above the
    // whole-row-click overlay so the bubble fires; `focusable={false}` keeps
    // the button as the sole tab stop.
    <Tooltip
      className="relative z-10"
      focusable={false}
      content={`${label} — ${issueCount} ${issueWord} flagged. Click for the full breakdown.`}
    >
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={controlsId}
        // Screen-reader announcement per AC: "Severity: Critical. 6 issues. …".
        aria-label={`Severity: ${label}. ${issueCount} ${issueWord}. Show priority breakdown.`}
        onClick={onToggle}
        data-testid="severity-summary-chip"
        data-severity={level}
        className={`relative z-10 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${classes}`}
      >
        <span aria-hidden="true">{glyph}</span>
        <span>{label}</span>
        <span
          aria-hidden="true"
          className={`ml-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-semibold leading-none tabular-nums ${badge}`}
        >
          {issueCount}
        </span>
      </button>
    </Tooltip>
  );
}

export const SeveritySummaryChip = memo(SeveritySummaryChipImpl);
