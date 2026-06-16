"use client";

// React provider over the recent-case-notes store. Two contexts split so
// rendering surfaces (timelines) re-render only on state changes while the
// reconciler hook gets a stable dispatch reference. Same split shadcn-style
// providers use; preserves perf at the F-07 timeline scale (10..50 rows per
// participant is the spec's expected order, but a re-render on every dispatch
// of every participant would be wasteful).

import {
  createContext,
  useContext,
  useMemo,
  useReducer,
  type ReactNode,
} from "react";

import type { LogCallResponseBody } from "@anthos/api";

import {
  EMPTY_STORE,
  getForParticipant,
  reduce,
  type StoreAction,
} from "./store";
import type {
  LocalCaseNote,
  LocalCaseNotesByParticipant,
  OptimisticCaseNote,
} from "./types";

const StateContext = createContext<LocalCaseNotesByParticipant | null>(null);

export interface RecentCaseNotesDispatch {
  readonly insertOptimistic: (optimistic: OptimisticCaseNote) => void;
  readonly replaceWithCanonical: (
    optimisticId: string,
    canonical: LogCallResponseBody,
    traceId: string | null,
  ) => void;
  readonly rollback: (participantId: string, optimisticId: string) => void;
}

const DispatchContext = createContext<RecentCaseNotesDispatch | null>(null);

interface ProviderProps {
  readonly children: ReactNode;
}

export function RecentCaseNotesProvider({ children }: ProviderProps) {
  const [state, dispatch] = useReducer(reduce, EMPTY_STORE);

  const value = useMemo<RecentCaseNotesDispatch>(
    () => ({
      insertOptimistic: (optimistic) =>
        dispatch({ type: "optimistic_insert", optimistic } satisfies StoreAction),
      replaceWithCanonical: (optimisticId, canonical, traceId) =>
        dispatch({
          type: "confirmed_replace",
          optimisticId,
          canonical,
          traceId,
        } satisfies StoreAction),
      rollback: (participantId, optimisticId) =>
        dispatch({
          type: "rolled_back",
          participantId,
          optimisticId,
        } satisfies StoreAction),
    }),
    [],
  );

  return (
    <StateContext.Provider value={state}>
      <DispatchContext.Provider value={value}>
        {children}
      </DispatchContext.Provider>
    </StateContext.Provider>
  );
}

// Read hook for surfaces (the F-07 timeline, future SMS/email timelines).
// Returns the participant's local records in insertion order; render with
// `.slice().reverse()` if you want newest-first.
export function useRecentCaseNotes(
  participantId: string,
): ReadonlyArray<LocalCaseNote> {
  const state = useContext(StateContext);
  if (state === null) {
    throw new Error(
      "useRecentCaseNotes must be used inside <RecentCaseNotesProvider>.",
    );
  }
  // Memo would be wasted here — `getForParticipant` returns a stable
  // reference when nothing changed, and a new reference (caller's
  // responsibility to dep on) when it did.
  return getForParticipant(state, participantId);
}

// Dispatch hook for the reconciler. Stable across renders.
export function useRecentCaseNotesDispatch(): RecentCaseNotesDispatch {
  const dispatch = useContext(DispatchContext);
  if (dispatch === null) {
    throw new Error(
      "useRecentCaseNotesDispatch must be used inside <RecentCaseNotesProvider>.",
    );
  }
  return dispatch;
}

