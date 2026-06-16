import type { RowTag } from "@anthos/api";

// Hover-tooltip copy for the F-02 BARRIERS / TAGS cluster (P1H-05).
//
// Sibling to `tag-chip-variant.ts` — that file maps `severity` → Badge color;
// this file maps `key` → action-anchored definition. Kept separate so the
// severity mapping stays narrow and the copy table reads as one block.
//
// Mechanism: native `title=` attribute (codebase precedent — `BarrierBadge`,
// `ProgramModifierChip`). The strings are user-facing for caseload
// specialists; "definition + action verb" tone matches the F-02 wireframe's
// reminder use case (the AI-proposal invariant doesn't apply — these are
// static UI copy, not engine output).
//
// `voucher_critical_<N>d` is the only parameterized key family — the day
// count is baked into the key by `deriveRowTags` (see
// `packages/domain/src/tags/derive-row-tags.ts`). All other keys are static.
//
// Default branch: return `tag.label` so an unknown future key never crashes
// the row render; the chip still shows its existing label, just without
// expanded copy.

const STATIC_TOOLTIPS: Readonly<Record<string, string>> = Object.freeze({
  visit_overdue:
    "Visit overdue — upcoming visit date has passed; reschedule",
  cannot_reach: "Cannot reach — try a different contact channel",
  failed_attempts:
    "Multiple failed contact attempts — try a different channel",
  voucher_critical_overdue:
    "Voucher recertification overdue — escalate now",
  catch_up:
    "Missed checkpoint — complete the specific visit to clear it",
  recent_incident:
    "Recent incident reported — check participant details",
  arrears: "Open arrears — review payment status",
  path_c_suppression:
    "Seen by another provider — suppression active (BR-21)",
});

const VOUCHER_CRITICAL_NDAY = /^voucher_critical_(\d+)d$/;

export function tagChipTooltip(tag: RowTag): string {
  const voucherMatch = VOUCHER_CRITICAL_NDAY.exec(tag.key);
  if (voucherMatch !== null) {
    const days = voucherMatch[1];
    return `Voucher recert due in ${days} day${days === "1" ? "" : "s"} — act this week`;
  }
  return STATIC_TOOLTIPS[tag.key] ?? tag.label;
}
