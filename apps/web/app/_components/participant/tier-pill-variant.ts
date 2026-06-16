import { tierLabelFor } from "@anthos/domain";

// P1H-05 TIER cell — pill styling per the 2026-05-25 wireframe
// (`.tier-1/2/3` blocks). Soft-pastel-bg + dark-text + glyph; intentionally
// NOT the existing `tier1/2/3` Badge variants which are solid-fill
// high-contrast (used elsewhere for ID badges, kept for backwards
// compatibility). Pure mapping — extracted so the visual decision is
// testable without rendering.
//
// Glyph shape encodes tier without relying on color alone (a11y):
//   tier 1 → filled solid circle
//   tier 2 → filled solid circle with inner ring (half-fill effect)
//   tier 3 → outlined ring (empty circle)

export type TierGlyphShape = "filled" | "half" | "ring";

export interface TierPillVariant {
  readonly label: string;
  readonly numeral: string;
  readonly pillClassName: string;
  readonly glyphClassName: string;
  readonly glyphShape: TierGlyphShape;
  // Hover tooltip — definition + action verb so a specialist glancing at the
  // pill is reminded what the tier means and what to do next. Mechanism is
  // native `title=` (codebase precedent: BarrierBadge, ProgramModifierChip).
  readonly tooltip: string;
}

const NUMERALS: Readonly<Record<number, string>> = Object.freeze({
  1: "①",
  2: "②",
  3: "③",
});

export function tierPillVariant(tier: number | null): TierPillVariant | null {
  if (tier === 1) {
    return {
      label: tierLabelFor(1),
      numeral: NUMERALS[1] ?? "1",
      pillClassName: "bg-red-100 text-red-800",
      glyphClassName: "bg-red-600",
      glyphShape: "filled",
      tooltip: "Tier 1: highest urgency — reach this participant today",
    };
  }
  if (tier === 2) {
    return {
      label: tierLabelFor(2),
      numeral: NUMERALS[2] ?? "2",
      pillClassName: "bg-amber-100 text-amber-800",
      glyphClassName: "bg-amber-600 ring-2 ring-inset ring-amber-300",
      glyphShape: "half",
      tooltip: "Tier 2: elevated — schedule contact this week",
    };
  }
  if (tier === 3) {
    return {
      label: tierLabelFor(3),
      numeral: NUMERALS[3] ?? "3",
      pillClassName: "bg-slate-100 text-slate-700",
      glyphClassName: "bg-white border-2 border-slate-400",
      glyphShape: "ring",
      tooltip: "Tier 3: no urgent signal — standard cadence",
    };
  }
  return null;
}
