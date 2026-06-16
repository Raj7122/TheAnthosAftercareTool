// Pure mapping from F-06 severity tier → Badge variant. BR-38 says severity
// tier is reflected in badge color [INFERRED — UX to validate against
// accessibility needs]; the palette is defined in `tailwind.config.ts`
// (`barrierHigh` / `barrierMedium` / `barrierLow`) and ships flagged in the
// PR body for UX review before demo.
//
// `null` severity (a Type the M-CONFIG classification map does not cover —
// e.g. mid-deploy schema drift) renders as `muted` rather than collapsing to
// `barrierLow`. A specialist must see "we couldn't tier this" rather than
// "this is low priority".

export type BarrierBadgeSeverity = "high" | "medium" | "low" | null;

export type BarrierBadgeVariant =
  | "barrierHigh"
  | "barrierMedium"
  | "barrierLow"
  | "muted";

export function barrierBadgeVariant(
  severity: BarrierBadgeSeverity,
): BarrierBadgeVariant {
  switch (severity) {
    case "high":
      return "barrierHigh";
    case "medium":
      return "barrierMedium";
    case "low":
      return "barrierLow";
    case null:
      return "muted";
  }
}
