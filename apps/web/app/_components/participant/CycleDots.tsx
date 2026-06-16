import { memo } from "react";

import type { PerCheckpointBreakdownDto } from "@anthos/api";

import { Tooltip } from "@/components/ui/tooltip";

import { cycleDotVariant } from "./cycle-dot-variant";

interface Props {
  readonly perCheckpointBreakdown: ReadonlyArray<PerCheckpointBreakdownDto>;
}

function CycleDotsImpl({ perCheckpointBreakdown }: Props) {
  // Degraded path: DTO carries an empty array when the engine threw and the
  // row is in `dataIssues=['degraded_score']`. Render four neutral
  // placeholders so the cell shape stays stable and the row's visual rhythm
  // is preserved.
  //
  // role="img" is required so `aria-label` is permitted on this `<div>` per
  // ARIA — without a role, axe (aria-prohibited-attr) flags it as
  // WCAG 2.1 AA 4.1.2 invalid. The visual is graphical, the alt text is
  // text-only; `img` matches the intent.
  if (perCheckpointBreakdown.length === 0) {
    return (
      <div role="img" className="flex items-center gap-1.5" aria-label="Stability cycle unknown">
        {[0, 1, 2, 3].map((i) => (
          <span
            key={i}
            aria-hidden="true"
            className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-full border border-slate-200 bg-slate-50"
          />
        ))}
      </div>
    );
  }
  return (
    // `relative z-10` lifts the dots above the whole-row-click overlay so
    // hover reaches them (otherwise the row's stretched `<Link>` intercepts
    // the pointer and the tooltip never fires). Trade-off: a click that lands
    // exactly on a dot shows its tooltip instead of opening the detail view;
    // a click anywhere else in the row still navigates. `focusable={false}`
    // keeps the dots out of the tab order (4 per row × N rows would flood it);
    // the per-anchor `aria-label` already carries the state to screen readers.
    <div className="relative z-10 flex items-center gap-1.5">
      {perCheckpointBreakdown.map((entry) => {
        const v = cycleDotVariant(entry.anchor, entry.state);
        return (
          // Each anchor is its own announceable graphic — `role="img"` makes
          // the per-anchor `aria-label` permitted (4.1.2 / aria-prohibited-attr)
          // and preserves the per-checkpoint screen-reader story (one
          // announcement per anchor, not one for the whole row).
          <Tooltip key={entry.anchor} content={v.tooltip} focusable={false}>
            <span
              role="img"
              aria-label={v.ariaLabel}
              className={`inline-flex h-3.5 w-3.5 items-center justify-center rounded-full text-[9px] font-bold leading-none ${v.className}`}
            >
              <span aria-hidden="true">{v.glyph}</span>
            </span>
          </Tooltip>
        );
      })}
    </div>
  );
}

export const CycleDots = memo(CycleDotsImpl);
