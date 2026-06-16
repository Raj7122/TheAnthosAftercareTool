import type { RowTag } from "@anthos/api";

// Severity rollup for the F-02 caseload row — collapses the per-row `RowTag`
// cluster into a single triage signal so specialists read overall urgency
// before individual signals (Hick's / Miller's law: fewer decisions per row).
//
// PRESENTATION-ONLY. Sibling to `tag-chip-variant.ts` / `tag-chip-tooltip.ts`:
// derived entirely from the `tags` array already on the wire (`CaseloadItem.tags`,
// itself produced by `deriveRowTags` in @anthos/domain). The priority engine,
// the tag-derivation domain function, and the wire DTO are untouched — this
// just buckets the existing `severity` enum into three triage levels.
//
// Rule (ticket "Introduce Severity Summary"): the tag severities map directly
// onto the three levels —
//   - any `high` tag (visit_overdue / cannot_reach / voucher_critical_*) → critical
//   - else any `med` tag (catch_up / arrears / recent_incident)         → attention
//   - else (only `low`/`info`, or no tags)                              → monitor

export type SeverityLevel = "critical" | "attention" | "monitor";

export interface SeveritySummary {
  readonly level: SeverityLevel;
  // User-facing label for the chip + screen-reader announcement.
  readonly label: string;
  // Number of contributing signals — equals `tags.length`. The
  // cannot_reach/failed_attempts pair counts as two (matches the ticket's
  // own "6 Issues" example, which lists both chips).
  readonly issueCount: number;
}

// Mirrors `tag-chip-variant.ts`'s switch form (warning-free vs. a keyed-record
// lookup, which trips `security/detect-object-injection`).
function labelFor(level: SeverityLevel): string {
  switch (level) {
    case "critical":
      return "Critical";
    case "attention":
      return "Attention Needed";
    case "monitor":
      return "Monitor";
  }
}

export function severitySummary(tags: ReadonlyArray<RowTag>): SeveritySummary {
  const level: SeverityLevel = tags.some((t) => t.severity === "high")
    ? "critical"
    : tags.some((t) => t.severity === "med")
      ? "attention"
      : "monitor";
  return { level, label: labelFor(level), issueCount: tags.length };
}
