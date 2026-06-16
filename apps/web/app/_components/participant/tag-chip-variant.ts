import type { RowTag } from "@anthos/api";

// P1H-05 BARRIERS / TAGS cell — maps the P1H-03 `RowTag.severity` enum to
// the Badge variant for the chip. Distinct from `barrierBadgeVariant`
// because the BR-38 severity domain ("high"/"medium"/"low") and the row-tag
// severity domain ("high"/"med"/"low"/"info") are two separate enums; the
// "info" tier covers neutral signals (e.g., `path_c_suppression`) that
// don't map onto the barrier palette. (Aftercare Extended was the original
// info-tier example; P1H-14 moved it to `ProgramModifierChip` in the
// PARTICIPANT cell, so the TAGS cluster no longer renders it.)

export type TagChipVariant =
  | "barrierHigh"
  | "barrierMedium"
  | "barrierLow"
  | "info";

export function tagChipVariant(severity: RowTag["severity"]): TagChipVariant {
  switch (severity) {
    case "high":
      return "barrierHigh";
    case "med":
      return "barrierMedium";
    case "low":
      return "barrierLow";
    case "info":
      return "info";
  }
}
