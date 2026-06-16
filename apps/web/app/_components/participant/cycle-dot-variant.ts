import type { CheckpointAnchor, PerAnchorState } from "@anthos/domain";

// P1H-05 STABILITY CYCLE cell — 4-dot indicator (one dot per anchor). Maps
// the F-05 BR-33 five-state per-anchor palette onto class + glyph + a11y
// label. Pure mapping; the component is a presentation shell. Uses the same
// Tailwind tokens as `CycleBadge`'s `cycleBadgeDisplay` so the dot row and
// the row's existing badge land on the same green/orange/red/purple.

export interface CycleDotVariant {
  readonly className: string;
  readonly glyph: string;
  readonly ariaLabel: string;
  // Hover tooltip — definition + action verb. Per-dot (matches the existing
  // per-anchor `ariaLabel`) so hovering the red dot diagnoses the specific
  // missed checkpoint, not the aggregate. Mechanism is native `title=`.
  readonly tooltip: string;
}

const STATE_LABELS: Readonly<Record<PerAnchorState, string>> = Object.freeze({
  complete: "complete",
  due: "due",
  overdue: "overdue",
  catch_up: "catch-up",
  future: "future",
});

export function cycleDotVariant(
  anchor: CheckpointAnchor,
  state: PerAnchorState,
): CycleDotVariant {
  const ariaLabel = `${anchor}-day checkpoint: ${STATE_LABELS[state]}`;
  switch (state) {
    case "complete":
      return {
        className: "bg-cycleComplete text-white",
        glyph: "✓",
        ariaLabel,
        tooltip: `${anchor}-day visit completed`,
      };
    case "due":
      return {
        className: "bg-cycleDue text-white",
        glyph: "•",
        ariaLabel,
        tooltip: `${anchor}-day visit due soon — schedule it`,
      };
    case "overdue":
      // BR-33 colorblind-accessibility: red-overdue and purple-catch_up must
      // be distinguishable by glyph alone. The wireframe shows `!` for both;
      // we diverge so overdue ("missed, no catch-up coming") reads as `×`
      // while catch_up ("missed but a later checkpoint is upcoming") keeps
      // the `!` opportunity-remaining marker.
      return {
        className: "bg-cycleOverdue text-white",
        glyph: "×",
        ariaLabel,
        tooltip: `${anchor}-day visit overdue — schedule make-up`,
      };
    case "catch_up":
      return {
        className: "bg-cycleCatchUp text-white",
        glyph: "!",
        ariaLabel,
        tooltip: `${anchor}-day visit missed — catch-up required`,
      };
    case "future":
      return {
        className: "bg-white border border-slate-300 text-slate-300",
        glyph: "",
        ariaLabel,
        tooltip: `${anchor}-day visit: not yet reached`,
      };
  }
}
