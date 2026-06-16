// P1F-05 Pattern A — pure reducers over the local case-notes store.
//
// Extracted from the React provider so each reconciliation step (optimistic
// insert / confirmed replace / rollback) is testable as a value-in/value-out
// function — same shape the barriers Pattern A precedent uses
// (`apps/web/app/caseload/_lib/caseload-mutations.ts`). The provider does
// nothing more than `useReducer(reduce, EMPTY)` over these reducers.

import type {
  LocalCaseNote,
  LocalCaseNotesByParticipant,
  OptimisticCaseNote,
} from "./types";
import type { LogCallResponseBody } from "@anthos/api";

// Shared empty-store sentinel. `Object.freeze` here freezes own properties
// (none for a Map), NOT the Map's `.set` / `.delete` methods — calling
// those on this reference would still mutate it. The type-level
// `ReadonlyMap` is the load-bearing safety; the freeze is a defensive
// signal that this is a singleton sentinel, not a starter Map to grow.
export const EMPTY_STORE: LocalCaseNotesByParticipant = Object.freeze(
  new Map(),
) as LocalCaseNotesByParticipant;

// Insert an optimistic record at the head of the participant's list (Pattern
// A: "UI updates now"). Does NOT mutate the input map — copy-on-write
// preserves React's identity check semantics.
export function applyOptimistic(
  prev: LocalCaseNotesByParticipant,
  optimistic: OptimisticCaseNote,
): LocalCaseNotesByParticipant {
  const next = new Map(prev);
  const existing = next.get(optimistic.participantId) ?? [];
  const inserted: LocalCaseNote = { state: "saving", optimistic };
  next.set(optimistic.participantId, [inserted, ...existing]);
  return next;
}

// Replace a 'saving' record with its 'confirmed' counterpart on 2xx. The
// optimistic record stays in the union so the F-07 timeline keeps its key
// stable across the saving→confirmed transition (no jank). If the
// `optimisticId` isn't found (e.g., the participant was unmounted between
// submit and response) we return the input unchanged rather than throwing —
// this matches the barriers precedent: the optimistic store is best-effort
// UI state, not a ledger.
export function applyConfirmed(
  prev: LocalCaseNotesByParticipant,
  optimisticId: string,
  canonical: LogCallResponseBody,
  traceId: string | null,
): LocalCaseNotesByParticipant {
  const list = prev.get(canonical.participantId);
  if (list === undefined) return prev;
  const idx = list.findIndex(
    (r) => r.optimistic.optimisticId === optimisticId,
  );
  if (idx === -1) return prev;
  const target = list[idx];
  if (target === undefined) return prev;
  const replaced: LocalCaseNote = {
    state: "confirmed",
    optimistic: target.optimistic,
    canonical,
    traceId,
  };
  const nextList = list.slice();
  nextList[idx] = replaced;
  const next = new Map(prev);
  next.set(canonical.participantId, nextList);
  return next;
}

// Remove an optimistic record on terminal failure (Pattern A: rollback
// visibly — the row disappears; the sheet's banner carries the structured
// error). `participantId` is required because the store is keyed by it and
// we don't want to scan every participant's list on every rollback.
export function applyRollback(
  prev: LocalCaseNotesByParticipant,
  participantId: string,
  optimisticId: string,
): LocalCaseNotesByParticipant {
  const list = prev.get(participantId);
  if (list === undefined) return prev;
  const nextList = list.filter(
    (r) => r.optimistic.optimisticId !== optimisticId,
  );
  if (nextList.length === list.length) return prev;
  const next = new Map(prev);
  if (nextList.length === 0) {
    next.delete(participantId);
  } else {
    next.set(participantId, nextList);
  }
  return next;
}

// Read accessor — returns the empty array for an unknown participant so
// callers can `.map()` without a guard. Returns the same reference across
// calls when nothing changed (the reducers do copy-on-write at the map
// level, so referential equality on the inner list is preserved).
export function getForParticipant(
  store: LocalCaseNotesByParticipant,
  participantId: string,
): ReadonlyArray<LocalCaseNote> {
  return store.get(participantId) ?? EMPTY_LIST;
}

const EMPTY_LIST: ReadonlyArray<LocalCaseNote> = Object.freeze([]);

// ── Reducer wrapper ─────────────────────────────────────────────────────────
// Useful for `useReducer`. Kept here so tests can drive transitions via
// actions without standing up a React tree.

export type StoreAction =
  | {
      readonly type: "optimistic_insert";
      readonly optimistic: OptimisticCaseNote;
    }
  | {
      readonly type: "confirmed_replace";
      readonly optimisticId: string;
      readonly canonical: LogCallResponseBody;
      readonly traceId: string | null;
    }
  | {
      readonly type: "rolled_back";
      readonly participantId: string;
      readonly optimisticId: string;
    };

export function reduce(
  state: LocalCaseNotesByParticipant,
  action: StoreAction,
): LocalCaseNotesByParticipant {
  switch (action.type) {
    case "optimistic_insert":
      return applyOptimistic(state, action.optimistic);
    case "confirmed_replace":
      return applyConfirmed(
        state,
        action.optimisticId,
        action.canonical,
        action.traceId,
      );
    case "rolled_back":
      return applyRollback(state, action.participantId, action.optimisticId);
  }
}
