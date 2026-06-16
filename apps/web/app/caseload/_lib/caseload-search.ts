import type { CaseloadItem } from "@anthos/api";

// Client-side, view-layer-only participant search for the desktop caseload.
//
// GOVERNANCE: this filters only the items already loaded for the active queue.
// It does NOT fetch, does NOT touch BR-21 prioritization, and does NOT reorder
// — the surviving items keep their server-given (and any user-applied sort)
// order. Purely presentational.
//
// PII: `displayName` is participant PII. The query lives only in component
// state and never leaves the client (no URL, no fetch, no log). This helper is
// pure and synchronous so it stays out of every audit/error path.
//
// `import type { CaseloadItem }` only — value imports from @anthos/api drag
// `pg` into the client chunk (bundle-discipline memo).

// Returns true when `query` is blank (whitespace-only or empty) — a blank
// query is "no filter", so `filterCaseloadItems` returns the input by identity.
export function isBlankQuery(query: string): boolean {
  return query.trim().length === 0;
}

// Case-insensitive substring match across the participant name (primary) and
// the program code (secondary). Null-safe on both fields.
function matchesQuery(item: CaseloadItem, needle: string): boolean {
  const name = item.displayName?.toLowerCase() ?? "";
  if (name.includes(needle)) return true;
  const program = item.programCode?.toLowerCase() ?? "";
  return program.includes(needle);
}

// Filter the loaded queue's items by the search query. Blank query returns the
// input array by identity (no copy) so the default, unsearched render is a
// no-op pass-through, mirroring `applySort`'s default-state discipline.
export function filterCaseloadItems(
  items: ReadonlyArray<CaseloadItem>,
  query: string,
): ReadonlyArray<CaseloadItem> {
  if (isBlankQuery(query)) return items;
  const needle = query.trim().toLowerCase();
  return items.filter((item) => matchesQuery(item, needle));
}
