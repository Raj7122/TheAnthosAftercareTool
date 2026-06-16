import type { CaseloadItem } from "@anthos/api";

import { severitySummary } from "../../_components/participant/severity-summary";

// Client-side, view-layer-only sort for the desktop caseload table.
//
// GOVERNANCE: this does NOT touch BR-21 prioritization. Items arrive
// pre-sorted priority-descending from the server; the DEFAULT sort state
// renders them in *exact* server order (`applySort` returns the input array
// by identity — no copy, no re-sort). Sorting is additive, in-memory, and
// presentational. No engine, audit, idempotency, or DTO change.
//
// `import type { CaseloadItem }` only — value imports from @anthos/api drag
// `pg` into the client chunk (bundle-discipline memo).

// The five sortable columns. "Why this priority" and "Quick actions" are
// intentionally absent — they are not sortable.
export type SortColumn =
  | "participant"
  | "tier"
  | "lastContact"
  | "stability"
  | "severity";

export type SortDirection = "asc" | "desc";

// `direction: null` == default (server priority order). `applySort` treats a
// null column OR null direction as "no sort".
export interface SortState {
  readonly column: SortColumn | null;
  readonly direction: SortDirection | null;
}

export const DEFAULT_SORT: SortState = { column: null, direction: null };

// Human label for the live-region sentence. Must match the <th> text.
// Switch form (not a keyed-record lookup) to stay clear of
// `security/detect-object-injection`, matching `severity-summary.ts`.
function columnLabel(column: SortColumn): string {
  switch (column) {
    case "participant":
      return "Participant";
    case "tier":
      return "Tier";
    case "lastContact":
      return "Last contact";
    case "stability":
      return "Stability cycle";
    case "severity":
      return "Barriers / tags";
  }
}

// --- Ordinal ranks --------------------------------------------------------

// Severity: reuse the existing triage rollup, do NOT reinvent it. Higher =
// more urgent (critical worst).
function severityRank(item: CaseloadItem): number {
  switch (severitySummary(item.tags).level) {
    case "critical":
      return 3;
    case "attention":
      return 2;
    case "monitor":
      return 1;
  }
}

// Stability: a total-order scalar over the cycle status. Higher = more
// attention needed. Overdue rows take the positive range (more days overdue
// = worse); rows not yet due take the non-positive range keyed on how soon
// the next checkpoint is (sooner = closer to 0 = higher); a row with no
// upcoming checkpoint is the most stable. `daysOverdue` is always present
// and `daysToNext` is the only nullable input, so stability is never
// "missing" (it is fully ordered, never sinks to the nulls-last bucket).
function stabilityRank(item: CaseloadItem): number {
  const cs = item.cycleStatus;
  if (cs.daysOverdue > 0) return cs.daysOverdue;
  if (cs.daysToNext === null) return Number.NEGATIVE_INFINITY;
  return -cs.daysToNext;
}

// --- Per-column comparison ------------------------------------------------

interface ColumnSpec {
  // True when the row has no value for this column → always sorts LAST,
  // regardless of direction (one nulls-last convention across all columns).
  readonly missing: (item: CaseloadItem) => boolean;
  // Ascending comparison for two rows both known to be present. Negative
  // when `a` orders before `b`. Direction is applied by `applySort`.
  readonly compareAsc: (a: CaseloadItem, b: CaseloadItem) => number;
}

function specFor(column: SortColumn): ColumnSpec {
  switch (column) {
    case "participant":
      return {
        missing: (i) => i.displayName === null || i.displayName.length === 0,
        // Locale-aware, case/accents-insensitive.
        compareAsc: (a, b) =>
          (a.displayName as string).localeCompare(b.displayName as string, undefined, {
            sensitivity: "base",
          }),
      };
    case "tier":
      return {
        missing: (i) => i.tier === null,
        compareAsc: (a, b) => (a.tier as number) - (b.tier as number),
      };
    case "lastContact":
      return {
        // null == never contacted → sorts last in both directions per the
        // confirmed nulls-last convention.
        missing: (i) => i.lastSuccessfulContactDaysAgo === null,
        compareAsc: (a, b) =>
          (a.lastSuccessfulContactDaysAgo as number) -
          (b.lastSuccessfulContactDaysAgo as number),
      };
    case "stability":
      return {
        missing: () => false,
        compareAsc: (a, b) => stabilityRank(a) - stabilityRank(b),
      };
    case "severity":
      return {
        missing: () => false,
        compareAsc: (a, b) => {
          const r = severityRank(a) - severityRank(b);
          if (r !== 0) return r;
          // Same level: fewer issues first (ascending). Descending reverses,
          // surfacing the busiest critical rows first.
          return severitySummary(a.tags).issueCount - severitySummary(b.tags).issueCount;
        },
      };
  }
}

// --- Application ----------------------------------------------------------

// Pure, stable sort. Returns `items` BY IDENTITY when state is default
// (no copy, no re-sort) so the server priority order is preserved exactly.
// Never mutates the input. Missing keys always sort last; ties (and the
// all-missing case) fall back to original index so the order is stable and
// engine-independent.
export function applySort(
  items: ReadonlyArray<CaseloadItem>,
  sort: SortState,
): ReadonlyArray<CaseloadItem> {
  if (sort.column === null || sort.direction === null) {
    return items;
  }
  const spec = specFor(sort.column);
  const dir = sort.direction === "asc" ? 1 : -1;

  const decorated = items.map((item, index) => ({ item, index }));
  decorated.sort((x, y) => {
    const mx = spec.missing(x.item);
    const my = spec.missing(y.item);
    if (mx && my) return x.index - y.index;
    if (mx) return 1;
    if (my) return -1;
    const cmp = spec.compareAsc(x.item, y.item);
    if (cmp !== 0) return dir * cmp;
    return x.index - y.index;
  });

  return decorated.map((d) => d.item);
}

// --- Tri-state reducer ----------------------------------------------------

export type SortAction = { readonly type: "click"; readonly column: SortColumn };

// A NEW column jumps to that column ascending. The SAME column cycles
// asc → desc → default(null) → asc.
export function sortReducer(state: SortState, action: SortAction): SortState {
  if (action.type !== "click") return state;
  if (state.column !== action.column) {
    return { column: action.column, direction: "asc" };
  }
  if (state.direction === "asc") {
    return { column: action.column, direction: "desc" };
  }
  if (state.direction === "desc") {
    return DEFAULT_SORT;
  }
  return { column: action.column, direction: "asc" };
}

// --- Live-region sentence -------------------------------------------------

export function describeSort(sort: SortState): string {
  if (sort.column === null || sort.direction === null) {
    return "Default order";
  }
  const direction = sort.direction === "asc" ? "ascending" : "descending";
  return `Sorted by ${columnLabel(sort.column)} ${direction}`;
}
