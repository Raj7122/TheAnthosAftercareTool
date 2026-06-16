"use client";

// P3C-02 — Zustand store for in-flight compose-surface drafts on the tablet
// PWA surface (TR-OFFLINE-7b, BR-69, ADR-05 §6.5a per SAD v1.2).
//
// Surface gate (ADR-05 bifurcation): persist writes go to IndexedDB only
// when `isTopLevelOriginSurface()` is true. Inside the Salesforce Lightning
// Web Tab iframe (§6.5b), the same store API works but writes land in an
// in-memory `Map` — drafts survive sheet close→reopen within the tab session
// and die on reload, matching AC #5 "desktop iframe surface drafts are
// session-only (no IndexedDB persistence)". The gate is evaluated lazily
// inside `createJSONStorage(() => …)` so SSR never touches IDB.
//
// Per-specialist scoping (AC #4): each draft is keyed
// `${specialistId}:${participantId}`. `syncActiveSpecialist(incoming)` is
// called from `useDraftStoreSync` once a session is bootstrapped; on a
// mismatch with the persisted `activeSpecialistId` it purges every draft
// across all five surfaces. This is the "switching specialist context
// purges other specialists' drafts" behavior the ticket DoD requires.

import { useEffect } from "react";
import {
  get as idbGet,
  set as idbSet,
  del as idbDel,
} from "idb-keyval";
import { create } from "zustand";
import {
  createJSONStorage,
  persist,
  type StateStorage,
} from "zustand/middleware";

import { isTopLevelOriginSurface } from "../pwa-surface";
import { draftsKvStore } from "./kv";
import {
  DRAFTS_PERSIST_KEY,
  makeDraftScopeKey,
  type CreateBarrierDraft,
  type DraftScopeKey,
  type EmailComposeDraft,
  type LogCallDraft,
  type ScheduleVisitDraft,
  type SmsComposeDraft,
} from "./types";

// idb-keyval-backed StateStorage adapter. Zustand persist calls
// `getItem/setItem/removeItem` against a single key (DRAFTS_PERSIST_KEY)
// holding the JSON-serialized slice. idb-keyval handles connection
// serialization internally.
const idbStorage: StateStorage = {
  getItem: async (name) => (await idbGet<string>(name, draftsKvStore())) ?? null,
  setItem: async (name, value) => {
    await idbSet(name, value, draftsKvStore());
  },
  removeItem: async (name) => {
    await idbDel(name, draftsKvStore());
  },
};

// In-memory fallback for the iframe surface (ADR-05 §6.5b). The Map lives
// for the page lifetime; reload wipes it, matching AC #5. Module-scoped so
// the singleton model matches `idbStorage`.
const inMemoryStorageMap = new Map<string, string>();
const memoryStorage: StateStorage = {
  getItem: (name) => inMemoryStorageMap.get(name) ?? null,
  setItem: (name, value) => {
    inMemoryStorageMap.set(name, value);
  },
  removeItem: (name) => {
    inMemoryStorageMap.delete(name);
  },
};

// Test seam: clears the in-memory map so a guard test that flips the surface
// to "iframe" can observe non-persistence without leaking state across tests.
export function resetMemoryStorageForTests(): void {
  inMemoryStorageMap.clear();
}

// Storage picker — pure function on top of `isTopLevelOriginSurface()` so the
// surface bifurcation gate is unit-testable without spinning up the whole
// Zustand persist machinery. Top-level (tablet PWA / direct-to-PWA laptop)
// gets the idb-keyval-backed adapter; iframe (Salesforce Console embed) gets
// the in-memory map (matches AC #5: drafts session-only on the iframe
// surface).
export function pickDraftStateStorage(): StateStorage {
  return isTopLevelOriginSurface() ? idbStorage : memoryStorage;
}

// Persisted slice (the part `partialize` writes through `idbStorage`). The
// action functions are kept on the runtime store object but are excluded
// from serialization — functions are not JSON-safe.
interface DraftPersistedState {
  readonly activeSpecialistId: string | null;
  readonly logCall: Readonly<Record<DraftScopeKey, LogCallDraft>>;
  readonly createBarrier: Readonly<Record<DraftScopeKey, CreateBarrierDraft>>;
  readonly smsCompose: Readonly<Record<DraftScopeKey, SmsComposeDraft>>;
  readonly emailCompose: Readonly<Record<DraftScopeKey, EmailComposeDraft>>;
  readonly scheduleVisit: Readonly<Record<DraftScopeKey, ScheduleVisitDraft>>;
}

interface DraftActions {
  readonly setLogCallDraft: (
    specialistId: string,
    participantId: string,
    patch: LogCallDraft,
  ) => void;
  readonly clearLogCallDraft: (
    specialistId: string,
    participantId: string,
  ) => void;
  readonly setCreateBarrierDraft: (
    specialistId: string,
    participantId: string,
    patch: CreateBarrierDraft,
  ) => void;
  readonly clearCreateBarrierDraft: (
    specialistId: string,
    participantId: string,
  ) => void;
  readonly setSmsComposeDraft: (
    specialistId: string,
    participantId: string,
    patch: SmsComposeDraft,
  ) => void;
  readonly clearSmsComposeDraft: (
    specialistId: string,
    participantId: string,
  ) => void;
  readonly setEmailComposeDraft: (
    specialistId: string,
    participantId: string,
    patch: EmailComposeDraft,
  ) => void;
  readonly clearEmailComposeDraft: (
    specialistId: string,
    participantId: string,
  ) => void;
  readonly setScheduleVisitDraft: (
    specialistId: string,
    participantId: string,
    patch: ScheduleVisitDraft,
  ) => void;
  readonly clearScheduleVisitDraft: (
    specialistId: string,
    participantId: string,
  ) => void;
  readonly syncActiveSpecialist: (incoming: string) => void;
  readonly resetAllForTests: () => void;
}

export type DraftState = DraftPersistedState & DraftActions;

const EMPTY_PERSISTED_STATE: DraftPersistedState = {
  activeSpecialistId: null,
  logCall: {},
  createBarrier: {},
  smsCompose: {},
  emailCompose: {},
  scheduleVisit: {},
};

// Patches a single (scope-key, draft) entry into a surface map. Used by every
// `setXDraft` action to avoid duplicating the merge / immutable-write shape.
function patchSurface<TDraft extends object>(
  current: Readonly<Record<DraftScopeKey, TDraft>>,
  key: DraftScopeKey,
  patch: TDraft,
): Readonly<Record<DraftScopeKey, TDraft>> {
  const existing = current[key];
  return {
    ...current,
    [key]: { ...(existing ?? ({} as TDraft)), ...patch },
  };
}

function removeFromSurface<TDraft extends object>(
  current: Readonly<Record<DraftScopeKey, TDraft>>,
  key: DraftScopeKey,
): Readonly<Record<DraftScopeKey, TDraft>> {
  if (!(key in current)) return current;
  const next = { ...current };
  delete next[key];
  return next;
}

export const useDraftStore = create<DraftState>()(
  persist(
    (set) => ({
      ...EMPTY_PERSISTED_STATE,

      setLogCallDraft: (specialistId, participantId, patch) =>
        set((state) => ({
          logCall: patchSurface(
            state.logCall,
            makeDraftScopeKey(specialistId, participantId),
            patch,
          ),
        })),
      clearLogCallDraft: (specialistId, participantId) =>
        set((state) => ({
          logCall: removeFromSurface(
            state.logCall,
            makeDraftScopeKey(specialistId, participantId),
          ),
        })),

      setCreateBarrierDraft: (specialistId, participantId, patch) =>
        set((state) => ({
          createBarrier: patchSurface(
            state.createBarrier,
            makeDraftScopeKey(specialistId, participantId),
            patch,
          ),
        })),
      clearCreateBarrierDraft: (specialistId, participantId) =>
        set((state) => ({
          createBarrier: removeFromSurface(
            state.createBarrier,
            makeDraftScopeKey(specialistId, participantId),
          ),
        })),

      setSmsComposeDraft: (specialistId, participantId, patch) =>
        set((state) => ({
          smsCompose: patchSurface(
            state.smsCompose,
            makeDraftScopeKey(specialistId, participantId),
            patch,
          ),
        })),
      clearSmsComposeDraft: (specialistId, participantId) =>
        set((state) => ({
          smsCompose: removeFromSurface(
            state.smsCompose,
            makeDraftScopeKey(specialistId, participantId),
          ),
        })),

      setEmailComposeDraft: (specialistId, participantId, patch) =>
        set((state) => ({
          emailCompose: patchSurface(
            state.emailCompose,
            makeDraftScopeKey(specialistId, participantId),
            patch,
          ),
        })),
      clearEmailComposeDraft: (specialistId, participantId) =>
        set((state) => ({
          emailCompose: removeFromSurface(
            state.emailCompose,
            makeDraftScopeKey(specialistId, participantId),
          ),
        })),

      setScheduleVisitDraft: (specialistId, participantId, patch) =>
        set((state) => ({
          scheduleVisit: patchSurface(
            state.scheduleVisit,
            makeDraftScopeKey(specialistId, participantId),
            patch,
          ),
        })),
      clearScheduleVisitDraft: (specialistId, participantId) =>
        set((state) => ({
          scheduleVisit: removeFromSurface(
            state.scheduleVisit,
            makeDraftScopeKey(specialistId, participantId),
          ),
        })),

      // Per-specialist purge (AC #4). The first time a session resolves an
      // identity, `activeSpecialistId` is null and we adopt the incoming
      // value without dropping anything (a brand-new tab can't have stale
      // drafts to purge). On any subsequent mismatch we drop every surface
      // map — the previous specialist's drafts MUST NOT leak into the new
      // one's compose sheets.
      syncActiveSpecialist: (incoming) =>
        set((state) => {
          if (state.activeSpecialistId === incoming) return state;
          if (state.activeSpecialistId === null) {
            return { ...state, activeSpecialistId: incoming };
          }
          return { ...EMPTY_PERSISTED_STATE, activeSpecialistId: incoming };
        }),

      // Test seam — drops in-memory slice AND `activeSpecialistId`. The
      // backing IDB / memory storage is wiped separately via `wipeDrafts()`
      // (see `./wipe.ts`).
      resetAllForTests: () => set(() => ({ ...EMPTY_PERSISTED_STATE })),
    }),
    {
      name: DRAFTS_PERSIST_KEY,
      // `createJSONStorage` calls the picker EAGERLY at persist-middleware
      // init time and captures the chosen adapter in a closure for the
      // lifetime of this JS context (see zustand/middleware persistImpl).
      // Two JS contexts in Next.js App Router:
      //   - Server render: `typeof window === "undefined"` so
      //     `isTopLevelOriginSurface()` returns false, picker yields
      //     `memoryStorage`. SSR never touches IDB and the in-memory map
      //     drains with the request — no persistence path on the server.
      //   - Client (post-hydration): a fresh module init runs in the
      //     browser; `window` is defined and the picker yields `idbStorage`
      //     on the top-level surface or `memoryStorage` inside the iframe.
      storage: createJSONStorage(() => pickDraftStateStorage()),
      // Functions are not JSON-safe; persist only the data slice.
      partialize: (state): DraftPersistedState => ({
        activeSpecialistId: state.activeSpecialistId,
        logCall: state.logCall,
        createBarrier: state.createBarrier,
        smsCompose: state.smsCompose,
        emailCompose: state.emailCompose,
        scheduleVisit: state.scheduleVisit,
      }),
    },
  ),
);

// Hook for the caseload (and future tablet routes) to fire the per-specialist
// sync once per session bootstrap. Caller passes the specialist id resolved
// from `/me`; the hook dispatches to the store on mount and on incoming
// identity changes. The action itself is idempotent on a matching id.
//
// IDB-rehydration race (correctness-critical): Zustand's `persist` middleware
// reads from IDB asynchronously after the store is created. If we ran
// `syncActiveSpecialist` immediately on mount, the in-memory slice would
// still show `activeSpecialistId === null` (the initial state), so the
// "first adoption" branch would adopt the incoming id WITHOUT purging.
// Rehydration would then finish a microtask later and restore the PREVIOUS
// specialist's drafts + their `activeSpecialistId` from IDB — the next
// sheet open would surface another specialist's draft text. That's exactly
// the leak AC #4 forbids. So we gate the dispatch on
// `persist.onFinishHydration` when hydration is still pending; on a
// subsequent specialist switch within the same tab, `hasHydrated()` is
// already true and the sync runs synchronously.
export function useDraftStoreSync(specialistId: string): void {
  const syncActiveSpecialist = useDraftStore((s) => s.syncActiveSpecialist);
  useEffect(() => {
    if (useDraftStore.persist.hasHydrated()) {
      syncActiveSpecialist(specialistId);
      return;
    }
    const unsubscribe = useDraftStore.persist.onFinishHydration(() => {
      syncActiveSpecialist(specialistId);
    });
    return () => {
      unsubscribe();
    };
  }, [syncActiveSpecialist, specialistId]);
}
