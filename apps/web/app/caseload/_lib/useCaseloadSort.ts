"use client";

import { useMemo, useReducer } from "react";

import type { CaseloadItem } from "@anthos/api";

import {
  applySort,
  describeSort,
  DEFAULT_SORT,
  sortReducer,
  type SortColumn,
  type SortState,
} from "./caseload-sort";

export type AriaSort = "none" | "ascending" | "descending";

export interface UseCaseloadSort {
  // Items in current sort order. Identity-equal to the input when the sort
  // state is default (server priority order — BR-21 untouched).
  readonly sortedItems: ReadonlyArray<CaseloadItem>;
  readonly sort: SortState;
  // Tri-state cycle for a header click (column → asc → desc → default).
  readonly onSortColumn: (column: SortColumn) => void;
  // aria-sort value for a given column header.
  readonly ariaSortFor: (column: SortColumn) => AriaSort;
  // Visually-hidden live-region sentence, e.g. "Sorted by Tier ascending".
  readonly announcement: string;
}

// Owns the desktop caseload table's sort state. Colocated with CaseloadList
// (not lifted to CaseloadView) so the tablet card variant and the shared
// parent stay free of a desktop-only concern — zero diff to CaseloadView.
//
// Sort state PERSISTS across queue-switch / refresh: the memo re-applies on
// the new `items`. A specialist who sorted by Last contact keeps that view
// after a refresh rather than snapping back.
export function useCaseloadSort(
  items: ReadonlyArray<CaseloadItem>,
): UseCaseloadSort {
  const [sort, dispatch] = useReducer(sortReducer, DEFAULT_SORT);

  const sortedItems = useMemo(() => applySort(items, sort), [items, sort]);

  return {
    sortedItems,
    sort,
    onSortColumn: (column) => dispatch({ type: "click", column }),
    ariaSortFor: (column) =>
      sort.column !== column || sort.direction === null
        ? "none"
        : sort.direction === "asc"
          ? "ascending"
          : "descending",
    announcement: describeSort(sort),
  };
}
