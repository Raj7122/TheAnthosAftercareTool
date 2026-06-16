"use client";

import { Calendar, ListFilter } from "lucide-react";
import { useCallback, useState, useTransition } from "react";

import type { CaseloadBody, CaseloadOpenBarrier } from "@anthos/api";
import { newIdempotencyKey } from "@anthos/domain";

import { useDeviceVariant } from "@/lib/device";

import { RecentCaseNotesProvider } from "../../_lib/case-notes/context";
import { useLogCallReconciler } from "../../_lib/log-call/use-log-call-reconciler";
import {
  useDraftStore,
  useDraftStoreSync,
} from "../../_lib/offline/drafts/store";
import { filterCaseloadItems, isBlankQuery } from "../_lib/caseload-search";
import { useCaseloadActivity } from "../_lib/useCaseloadActivity";
import { useCaseloadMutations } from "../_lib/useCaseloadMutations";
import type { MutationFailure } from "../_lib/useCaseloadMutations";
import type { LogCallInput } from "../_lib/useLogCallMutation";
import { useRefreshCaseload } from "../_lib/useRefreshCaseload";
import { CloseBarrierConfirm } from "../../_components/barriers/CloseBarrierConfirm";
import { CreateRepairSheet } from "../../_components/repairs/CreateRepairSheet";
import { useRepairMutation } from "../../_components/repairs/useRepairMutation";
import type {
  CreateRepairInput,
  OptimisticRepair,
} from "../../_components/repairs/types";
import { LogCaseNoteSheet } from "../../_components/case-notes/LogCaseNoteSheet";
import { useCaseNoteMutation } from "../../_components/case-notes/useCaseNoteMutation";
import type {
  CreateCaseNoteInput,
  OptimisticCaseNote,
} from "../../_components/case-notes/types";
import type { CaseloadCalendarEvent } from "../../_lib/calendar/caseload-events";
import { TabletCaseloadList } from "../../_components/tablet/TabletCaseloadList";
import { CaseloadCalendar } from "./CaseloadCalendar";
import { CaseloadList } from "./CaseloadList";
import { LogCallSheet } from "./LogCallSheet";
import { ParticipantSearch } from "./ParticipantSearch";
import { PendingSyncBadge } from "./PendingSyncBadge";
import { QueueSelector } from "./QueueSelector";
import { RefreshButton } from "./RefreshButton";
import { StaleIndicator } from "./StaleIndicator";

interface Props {
  readonly initialBody: CaseloadBody;
  readonly initialFetchedAt: string;
  readonly role: SessionRole;
  readonly barrierTypes: ReadonlyArray<string>;
  // P3C-02 — threaded from `/me` so the form-draft store can scope drafts
  // per specialist and purge other specialists' drafts on a session switch.
  readonly specialistId: string;
  // P3D-03 — drives the page header (avatar initials + caseload title). May be
  // null on a session without a resolved display name (renders generic chrome).
  readonly displayName: string | null;
}

// Session role enum matches the lowercase wire shape from /api/v1/me. UI
// affordances for create/close-Barrier render only for BR-35 / BR-36-eligible
// roles; the endpoint is the authoritative gate, the UI just hides clutter.
export type SessionRole = "specialist" | "supervisor" | "vp" | "system_admin";

interface CloseTarget {
  readonly participantId: string;
  readonly barrier: CaseloadOpenBarrier;
}

// Per-sheet F-08 Log-a-Call state. The `idempotencyKey` is minted once in
// the open-handler's state initializer and reused across in-sheet retries
// per Pattern D (ticket §AC: "generated at sheet-open time and reused
// across in-sheet retries"). Close → null → reopen mints a fresh key.
interface LogCallSheetState {
  readonly participantId: string;
  readonly idempotencyKey: string;
}

// Top-level interactive caseload view. Owns the active queue id, the most
// recent E-06 response body, and the fetch transitioned when the user
// switches queues. Initial render is hydrated from the Server Component to
// hit AC-05; subsequent queue switches are client-side (AC-14 < 1s warm).
//
// Also owns the F-06 (P1E-04a) create-Barrier sheet + close-Barrier
// confirmation state, and the Pattern A optimistic-UI hook that backs them.
//
// P1F-05 wires F-08 Log-a-Call through the recent-case-notes Pattern A
// reconciler — the provider mounts here so `useLogCallReconciler` (inside
// `CaseloadViewInner`) can dispatch into the store. The store is the
// architectural seam P1F-08 (F-07 detail page SPA shell) will consume via
// `useRecentCaseNotes(participantId)`; caseload itself doesn't render a
// recent-contacts timeline today, so the visible Pattern A feedback comes
// from the sheet's `Saving…` state + banner-on-rollback (which already
// shipped in P1F-04). The optimistic+confirmed records sit in the store
// invisibly until P1F-08 mounts a consumer.

export function CaseloadView(props: Props) {
  return (
    <RecentCaseNotesProvider>
      <CaseloadViewInner {...props} />
    </RecentCaseNotesProvider>
  );
}

function CaseloadViewInner({
  initialBody,
  initialFetchedAt,
  role,
  specialistId,
  displayName,
}: Props) {
  // P3C-02 — purge other specialists' drafts on a session switch
  // (AC #4). The store's `syncActiveSpecialist` action is idempotent on a
  // matching id, so re-renders here are safe.
  useDraftStoreSync(specialistId);
  // F-23 — additive surface toggle. Priority queues stay the default landing
  // (the calibration-gated triage surface); the calendar is a planning view
  // over the same already-loaded items (no extra fetch — BR-97-style).
  const [surface, setSurface] = useState<"queues" | "calendar">("queues");
  const [body, setBody] = useState<CaseloadBody>(initialBody);
  const [fetchedAt, setFetchedAt] = useState<Date>(
    () => new Date(initialFetchedAt),
  );
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  // The "+" quick action now logs a Repair (not a barrier). `createRepairFor`
  // holds the participant the Add Repair sheet is open for; `optimisticRepairs`
  // are this session's logged repairs, surfaced on the calendar (client-only,
  // reset on reload — the authoritative record is the Repair__c the BFF wrote).
  const [createRepairFor, setCreateRepairFor] = useState<string | null>(null);
  const [optimisticRepairs, setOptimisticRepairs] = useState<
    ReadonlyArray<OptimisticRepair>
  >([]);
  // The 📝 quick action logs a general Case Note (IDW_Case_Note__c).
  const [caseNoteSheetFor, setCaseNoteSheetFor] = useState<string | null>(null);
  const [optimisticCaseNotes, setOptimisticCaseNotes] = useState<
    ReadonlyArray<OptimisticCaseNote>
  >([]);
  const [logCallSheet, setLogCallSheet] = useState<LogCallSheetState | null>(
    null,
  );
  const [closeTarget, setCloseTarget] = useState<CloseTarget | null>(null);
  // P-UI — desktop participant search. View-layer only; the query stays in
  // component state and never enters the URL/log (`displayName` is PII).
  const [searchQuery, setSearchQuery] = useState("");
  // F-16 diff indicator state. Lives only in memory — the spec calls for an
  // ephemeral, in-session affordance (ticket §"DOES NOT do": no persistence
  // across reloads).
  const [changedIds, setChangedIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  const canMutateBarriers = role !== "system_admin";
  // The "+" repair launcher mirrors the barrier-mutation gate (server is the
  // authoritative authz; hiding the button avoids a 403 UX trap).
  const canMutateRepairs = role !== "system_admin";
  // The 📝 Log Case Note launcher mirrors the barrier/repair-mutation gate.
  const canLogCaseNotes = role !== "system_admin";
  // FS v1.12 §F-08 User Permissions (lines 845-846): Specialist-only write.
  // Server is authoritative (`ROLE_INSUFFICIENT_SCOPE` on misuse); hiding
  // the launcher avoids a UX trap for Supervisor/VP who would just hit a
  // 403 on click. SystemAdmin is hidden by the same rule.
  const canLogCalls = role === "specialist";

  const { items, pendingParticipantIds, closeBarrier } =
    useCaseloadMutations({ items: body.items });
  const { reconcileLogCall } = useLogCallReconciler();
  const { createRepair } = useRepairMutation();
  const { createCaseNote } = useCaseNoteMutation();

  // Resolve a participant's display name off the loaded caseload items so each
  // action sheet can title itself with the name (not the SF id). Mirrors the
  // `items.find(...)?.displayName` lookups in the submit handlers; null when
  // the row isn't in view, in which case the sheet falls back to the id.
  const nameFor = useCallback(
    (pid: string): string | null =>
      items.find((i) => i.participantId === pid)?.displayName ?? null,
    [items],
  );

  // P3B-03 / F-13 — device-variant routing for the caseload surface. SSR
  // defaults to 'laptop' per the `useDeviceVariant()` contract; hydration
  // swaps in the tablet card list if the four-signal AND-gate matches.
  // Data flows through the same prop bag — the BFF stays variant-agnostic.
  const deviceVariant = useDeviceVariant();

  // F-23 Phase B — fetch the activity layer (scheduled/completed visits, logged
  // comms, SMS) once the calendar surface is active; the calendar merges it with
  // the cache-derived Phase-A events and degrades to them if the fetch fails.
  const activity = useCaseloadActivity(surface === "calendar");

  // Desktop-only client-side search over the loaded queue's items. Blank query
  // returns `items` by identity, so the unsearched render is a pass-through.
  const searching = !isBlankQuery(searchQuery);
  const visibleItems = filterCaseloadItems(items, searchQuery);
  const searchEmptyMessage = searching
    ? `No participants match "${searchQuery.trim()}".`
    : undefined;

  const refreshState = useRefreshCaseload({
    currentItems: body.items,
    onRefreshed: ({ body: nextBody, changedIds: nextChanged }) => {
      setBody(nextBody);
      setFetchedAt(new Date());
      setChangedIds(nextChanged);
      setError(null);
    },
  });

  const handleSelect = useCallback(
    (queueId: string) => {
      if (queueId === body.queue) return;
      // A queue switch is an explicit user action; the F-16 highlight is
      // scoped to "rows that changed in the most recent refresh of THIS
      // view", so clearing here keeps the indicator unambiguous.
      setChangedIds(new Set());
      startTransition(() => {
        void switchQueue(queueId);
      });

      async function switchQueue(nextQueueId: string) {
        setError(null);
        try {
          const res = await fetch(
            `/api/v1/caseload?queue=${encodeURIComponent(nextQueueId)}`,
            { cache: "no-store", credentials: "same-origin" },
          );
          if (!res.ok) {
            const reason =
              res.status === 404
                ? "Unknown queue"
                : res.status === 401
                  ? "Session expired"
                  : `Request failed (${res.status})`;
            setError(reason);
            return;
          }
          const nextBody = (await res.json()) as CaseloadBody;
          setBody(nextBody);
          setFetchedAt(new Date());
        } catch (err) {
          setError(err instanceof Error ? err.message : "Network error");
        }
      }
    },
    [body.queue],
  );

  const handleOpenRepair = useCallback((participantId: string) => {
    setCreateRepairFor(participantId);
  }, []);

  const handleOpenCaseNote = useCallback((participantId: string) => {
    setCaseNoteSheetFor(participantId);
  }, []);

  const handleOpenLogCall = useCallback((participantId: string) => {
    // P1F-06 — tap-to-submit perf mark. The "tap Log call" instant per AC-30,
    // captured here so the E2E perf test can attribute the per-stage
    // breakdown without instrumenting the test runner. No-op in environments
    // without `performance.mark` (legacy browsers / SSR — neither reachable
    // on this code path, but defensive).
    performance.mark?.("logcall:sheet:open");
    // Mint the Pattern D key once at open time; the sheet reuses it across
    // in-sheet Submit retries. A close → reopen cycle creates a fresh
    // state object and therefore a fresh key.
    setLogCallSheet({
      participantId,
      idempotencyKey: newIdempotencyKey(),
    });
  }, []);

  const handleOpenClose = useCallback(
    (participantId: string, barrier: CaseloadOpenBarrier) => {
      setCloseTarget({ participantId, barrier });
    },
    [],
  );

  const handleCreateRepairSubmit = useCallback(
    async (
      participantId: string,
      input: CreateRepairInput,
    ): Promise<MutationFailure | null> => {
      const result = await createRepair(participantId, input);
      if (result.outcome === "failure") return result.failure;
      // Surface the just-logged repair on the calendar immediately (client-
      // only). The display name is read off the loaded caseload item so the
      // calendar event can label + deep-link it; null when not in view.
      const name =
        items.find((i) => i.participantId === participantId)?.displayName ??
        null;
      const record = result.record;
      setOptimisticRepairs((prev) => [
        {
          repairId: record.repairId,
          participantId: record.participantId,
          participantName: name,
          identificationDate: record.identificationDate,
          note: record.note,
          loggedAt: record.loggedAt,
        },
        ...prev,
      ]);
      setCreateRepairFor(null);
      return null;
    },
    [createRepair, items],
  );

  const handleCreateCaseNoteSubmit = useCallback(
    async (
      participantId: string,
      input: CreateCaseNoteInput,
    ): Promise<MutationFailure | null> => {
      const result = await createCaseNote(participantId, input);
      if (result.outcome === "failure") return result.failure;
      const name =
        items.find((i) => i.participantId === participantId)?.displayName ??
        null;
      const r = result.record;
      setOptimisticCaseNotes((prev) => [
        {
          caseNoteId: r.caseNoteId,
          participantId: r.participantId,
          participantName: name,
          serviceDate: r.serviceDate,
          note: r.note,
          contactType: r.contactType,
          type: r.type,
          status: r.status,
          loggedAt: r.loggedAt,
        },
        ...prev,
      ]);
      setCaseNoteSheetFor(null);
      return null;
    },
    [createCaseNote, items],
  );

  const handleCloseSubmit = useCallback(
    async (
      participantId: string,
      input: { barrierId: string; closureReason?: string },
    ): Promise<MutationFailure | null> => {
      const result = await closeBarrier(participantId, input);
      if (result.outcome === "success") {
        setCloseTarget(null);
        return null;
      }
      return result.failure;
    },
    [closeBarrier],
  );

  // P1F-05: Pattern A reconciliation now drives the F-08 submit. The
  // reconciler inserts the optimistic record into the recent-case-notes
  // store, runs the BFF round-trip (with at-most-1 5xx retry, same
  // idempotency key), replaces the optimistic record with the canonical
  // server record on 2xx, and rolls it back on terminal failure. We close
  // the sheet on success and surface the structured failure on rejection
  // (the sheet's banner / field-mapped errors carry the API §9 envelope).
  //
  // `priorityRecomputed` rides on the canonical record stored in the
  // recent-case-notes store; surface integration with the F-07 detail-page
  // priority card lands in P1F-08. Driving a caseload-row re-rank from
  // here (BR-42) is intentionally NOT done — the caseload renderer reads
  // `body.items` and would need a per-participant overlay; that's a
  // separate ticket and out of scope per P1F-05 §"DOES NOT do".
  const handleLogCallSubmit = useCallback(
    async (
      participantId: string,
      idempotencyKey: string,
      input: LogCallInput,
    ): Promise<MutationFailure | null> => {
      const failure = await reconcileLogCall(
        participantId,
        idempotencyKey,
        input,
      );
      if (failure === null) {
        // P3C-02 — drop the persisted draft on success so reopening the
        // sheet for the same (specialist, participant) starts empty. Done
        // BEFORE clearing the sheet state so the store mutation is on the
        // same render-tick path as the dialog detach (no visible flash).
        useDraftStore
          .getState()
          .clearLogCallDraft(specialistId, participantId);
        // P1F-06 — the "submit confirmation visible" instant per AC-30 is
        // the dialog detaching (which only happens on canonical 2xx). The
        // mark is set before the state update so the E2E perf test can
        // bracket the iteration as `sheet:open → sheet:closed`.
        performance.mark?.("logcall:sheet:closed");
        setLogCallSheet(null);
        return null;
      }
      return failure;
    },
    [reconcileLogCall, specialistId],
  );

  const refreshErrorMessage = formatRefreshError(refreshState);
  const inlineError = error ?? refreshErrorMessage;

  const showCalendar = surface === "calendar";

  // This session's logged repairs as caseload calendar events, plotted on the
  // logged date. The note text is never surfaced here — clicking the event
  // deep-links to the participant profile where the note is revealed on demand.
  const optimisticRepairEvents: ReadonlyArray<CaseloadCalendarEvent> =
    optimisticRepairs.map((r) => ({
      id: `${r.participantId}:repair-${r.repairId}`,
      ymd: r.identificationDate,
      kind: "repair" as const,
      title: "Repair logged",
      participantId: r.participantId,
      participantName: r.participantName,
    }));

  // This session's logged case notes as calendar events, plotted on the service
  // date. The note body is never surfaced here — clicking deep-links to the
  // participant profile where the note is revealed on demand.
  const optimisticCaseNoteEvents: ReadonlyArray<CaseloadCalendarEvent> =
    optimisticCaseNotes.map((c) => ({
      id: `${c.participantId}:case_note-${c.caseNoteId}`,
      ymd: c.serviceDate,
      kind: "case_note" as const,
      title: "Case note logged",
      detail: `${c.type} · ${c.contactType}`,
      participantId: c.participantId,
      participantName: c.participantName,
    }));

  return (
    <div className="space-y-4">
      {/* P3D-03 — page header: avatar + caseload title (left), live sync
          status + Refresh (right). Shared across both surfaces. */}
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Avatar displayName={displayName} />
          <h1 className="text-lg font-semibold leading-tight text-slate-900">
            {caseloadTitle(displayName)}
          </h1>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <PendingSyncBadge count={pendingParticipantIds.size} />
          <StaleIndicator
            cacheAgeSeconds={body.cacheAgeSeconds}
            fetchedAt={fetchedAt}
          />
          <RefreshButton
            state={refreshState.state}
            retryAfterSeconds={refreshState.retryAfterSeconds}
            onClick={() => {
              void refreshState.refresh();
            }}
          />
        </div>
      </header>
      {/* P3D-05 — stacked navigation: underline view tabs on their own row,
          the queue chips on a full-width row below (queues surface only — the
          calendar has its own month navigation). */}
      <SurfaceToggle surface={surface} onChange={setSurface} />
      {!showCalendar && (
        <QueueSelector
          queueCounts={body.queueCounts}
          activeQueueId={body.queue}
          onSelect={handleSelect}
          disabled={isPending}
        />
      )}
      {inlineError !== null && (
        <p
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {inlineError}
        </p>
      )}
      {/* P-UI — desktop participant search, full-width row above the list.
          Tablet keeps its own layout (search is out of scope there). Search is
          queue-only; the calendar has its own navigation. */}
      {deviceVariant !== "tablet" && !showCalendar && (
        <ParticipantSearch
          value={searchQuery}
          onChange={setSearchQuery}
          resultCount={visibleItems.length}
          controlsId="caseload-list"
        />
      )}
      <div aria-busy={isPending || refreshState.state === "pending"}>
        {showCalendar ? (
          <CaseloadCalendar
            items={items}
            variant={deviceVariant}
            activityEvents={activity.events}
            activityState={activity.state}
            optimisticRepairEvents={optimisticRepairEvents}
            optimisticCaseNoteEvents={optimisticCaseNoteEvents}
          />
        ) : deviceVariant === "tablet" ? (
          <TabletCaseloadList
            items={items}
            queueId={body.queue}
            canMutateBarriers={canMutateBarriers}
            canMutateRepairs={canMutateRepairs}
            canLogCaseNotes={canLogCaseNotes}
            canLogCalls={canLogCalls}
            pendingParticipantIds={pendingParticipantIds}
            changedParticipantIds={changedIds}
            onAddRepair={handleOpenRepair}
            onLogCaseNote={handleOpenCaseNote}
            onLogCall={handleOpenLogCall}
            onCloseBarrier={handleOpenClose}
          />
        ) : (
          <CaseloadList
            items={visibleItems}
            queueId={body.queue}
            canMutateBarriers={canMutateBarriers}
            canMutateRepairs={canMutateRepairs}
            canLogCaseNotes={canLogCaseNotes}
            canLogCalls={canLogCalls}
            pendingParticipantIds={pendingParticipantIds}
            changedParticipantIds={changedIds}
            emptyMessage={searchEmptyMessage}
            onAddRepair={handleOpenRepair}
            onLogCaseNote={handleOpenCaseNote}
            onLogCall={handleOpenLogCall}
            onCloseBarrier={handleOpenClose}
          />
        )}
      </div>

      {createRepairFor !== null && (
        <CreateRepairSheet
          participantId={createRepairFor}
          displayName={nameFor(createRepairFor)}
          onCancel={() => setCreateRepairFor(null)}
          onSubmit={(input) => handleCreateRepairSubmit(createRepairFor, input)}
        />
      )}

      {caseNoteSheetFor !== null && (
        <LogCaseNoteSheet
          participantId={caseNoteSheetFor}
          displayName={nameFor(caseNoteSheetFor)}
          onCancel={() => setCaseNoteSheetFor(null)}
          onSubmit={(input) =>
            handleCreateCaseNoteSubmit(caseNoteSheetFor, input)
          }
        />
      )}

      {logCallSheet !== null && (
        <LogCallSheet
          participantId={logCallSheet.participantId}
          displayName={nameFor(logCallSheet.participantId)}
          specialistId={specialistId}
          idempotencyKey={logCallSheet.idempotencyKey}
          onCancel={() => setLogCallSheet(null)}
          onSubmit={(input, key) =>
            handleLogCallSubmit(logCallSheet.participantId, key, input)
          }
        />
      )}

      {closeTarget !== null && (
        <CloseBarrierConfirm
          participantId={closeTarget.participantId}
          displayName={nameFor(closeTarget.participantId)}
          barrierId={closeTarget.barrier.barrierId}
          barrierType={closeTarget.barrier.type ?? "Unclassified"}
          onCancel={() => setCloseTarget(null)}
          onSubmit={(input) =>
            handleCloseSubmit(closeTarget.participantId, input)
          }
        />
      )}
    </div>
  );
}

// "Marie Alcis" → "Marie Alcis's caseload". Falls back to a generic "Caseload"
// title when /me carries no display name (e.g. a session without
// DEMO_SPECIALIST_DISPLAY_NAME and no SF-resolved name).
function caseloadTitle(displayName: string | null): string {
  const name = displayName?.trim();
  if (!name) return "Caseload";
  return `${name}'s caseload`;
}

// First letter of the first two words of the display name ("Marie Alcis" →
// "MA"). Falls back to "—" when there's no resolved name.
function caseloadInitials(displayName: string | null): string {
  const words = (displayName ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "—";
  return words
    .slice(0, 2)
    .map((w) => w.charAt(0).toUpperCase())
    .join("");
}

// P3D-03 — indigo initials avatar in the page header. Decorative; the caseload
// title carries the accessible name, so the avatar is aria-hidden.
function Avatar({ displayName }: { readonly displayName: string | null }) {
  return (
    <span
      aria-hidden="true"
      className="flex h-9 w-9 items-center justify-center rounded-full bg-indigo-600 text-sm font-semibold text-white"
    >
      {caseloadInitials(displayName)}
    </span>
  );
}

// F-23 — additive segmented control switching the caseload between the
// priority-ranked queues (default) and the activity calendar. A radiogroup so
// the two mutually-exclusive views are announced as a single control.
function SurfaceToggle({
  surface,
  onChange,
}: {
  readonly surface: "queues" | "calendar";
  readonly onChange: (next: "queues" | "calendar") => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Caseload view"
      className="flex items-center gap-1 border-b border-border"
    >
      {(
        [
          { id: "queues", label: "Priority queues", Icon: ListFilter },
          { id: "calendar", label: "Calendar", Icon: Calendar },
        ] as const
      ).map((option) => {
        const active = surface === option.id;
        return (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(option.id)}
            className={[
              "-mb-px inline-flex items-center gap-1.5 border-b-2 px-4 py-2.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              active
                ? "border-foreground font-medium text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            ].join(" ")}
          >
            <option.Icon aria-hidden="true" className="h-3.5 w-3.5" />
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

// The error envelope already carries a structured `code`; surface it inline
// next to the message so the specialist (and ops, reading a screenshot) can
// correlate to the API §9 catalog. 429 is handled in-button (countdown), so
// the alert only renders for terminal errors. PII firewall: the envelope's
// `code` + `message` come from `responses.ts` which the BFF guarantees
// PII-free, so we surface them as-is.
function formatRefreshError(
  refreshState: ReturnType<typeof useRefreshCaseload>,
): string | null {
  if (refreshState.state !== "error" || refreshState.error === null) {
    return null;
  }
  const { code, message } = refreshState.error;
  return `${message} [${code}]`;
}
