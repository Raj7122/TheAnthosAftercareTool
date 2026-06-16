"use client";

import { useCallback, useMemo, useState } from "react";

import type { CaseloadItem } from "@anthos/api";
import { newIdempotencyKey } from "@anthos/domain";

import { RecentCaseNotesProvider } from "../../_lib/case-notes/context";
import { useCaseNoteReconciler } from "../../_lib/case-notes/use-case-note-reconciler";
import { useRepairReconciler } from "../../_lib/repairs/use-repair-reconciler";
import { useOutbox, type OutboxItem } from "../../_lib/offline/use-outbox";
import type { CreateCaseNoteInput } from "../../_components/case-notes/types";
import type { CreateRepairInput } from "../../_components/repairs/types";
import type { MutationFailure } from "../../caseload/_lib/send-mutation";
import { QuickLogSheet } from "./QuickLogSheet";
import { CollapsedCaseload } from "./CollapsedCaseload";
import { PendingQueuePanel, type PendingRow } from "./PendingQueuePanel";
import { SectionDivider } from "./SectionDivider";
import { TabletHeader } from "./TabletHeader";
import { TopPriorityCard } from "./TopPriorityCard";

// P3B-02 / F-13 / BR-62 — tablet-variant landing surface, now LIVE (P3C-13).
//
// The hero is the top-priority participant from real F-02 data; its single
// primary action — "Log notes" — opens the Quick Log sheet (`QuickLogSheet`),
// routing the note to a Case Note (IDW_Case_Note__c) or a Repair (Repair__c),
// both offline-resilient via the Outbox mirror. The same Quick Log sheet backs
// the 📝 quick action on the caseload mini-list. Log Call is desktop-only on
// the tablet surface — the case note is the first-class offline field action.
// The Pending Sync panel is Outbox-sourced (`useOutbox`): queued / syncing /
// just-synced writes. The header badge reflects the Outbox count — the honest
// "work waiting to sync" signal.
//
// `RecentCaseNotesProvider` wraps the inner tree because the case-note / repair
// reconcilers dispatch into the recent-case-notes store (the same provider the
// caseload surface mounts).

interface Props {
  readonly initialCaseloadItems: ReadonlyArray<CaseloadItem>;
  readonly caseloadCount: number;
  readonly specialistName: string | null;
  // Threaded from `/me` and retained for prop-shape parity with `LandingSwitch`
  // (and the desktop branch, which still needs it). No longer consumed here now
  // that Log Call is desktop-only on the tablet surface.
  readonly specialistId: string | null;
  // P3C-14 — role gate for case-note writes (`role !== "system_admin"`). Gates
  // both the hero "Log notes" CTA (disabled, not hidden — BR-67) and the 📝
  // quick action on the caseload mini-list. Defaults to off so an unresolved /
  // read-only session never surfaces a write affordance.
  readonly canLogCaseNotes?: boolean;
}

interface QuickLogSheetState {
  readonly participantId: string;
  readonly idempotencyKey: string;
}

// Pull the participant id out of a queued `/calls`, `/case-notes`, or `/repairs`
// endpoint so syncing rows can show the participant's name (looked up from the
// live caseload).
function participantIdFromEndpoint(endpoint: string): string | null {
  const match = endpoint.match(/\/participants\/([^/]+)\/(?:calls|case-notes|repairs)$/);
  const captured = match?.[1];
  return captured === undefined ? null : decodeURIComponent(captured);
}

function buildSyncingRow(item: OutboxItem, nameById: ReadonlyMap<string, string>): PendingRow {
  const pid = participantIdFromEndpoint(item.endpoint);
  const name = (pid !== null ? nameById.get(pid) : undefined) ?? "participant";
  const body = item.body as { status?: string; type?: string } | null;
  if (/\/repairs$/.test(item.endpoint)) {
    return {
      kind: "syncing",
      id: item.id,
      title: `Repair · ${name}`,
      meta: "Repair",
      uiStatus: item.uiStatus,
    };
  }
  if (/\/case-notes$/.test(item.endpoint)) {
    return {
      kind: "syncing",
      id: item.id,
      title: `Case note · ${name}`,
      meta: `Type: ${body?.type ?? "Case note"}`,
      uiStatus: item.uiStatus,
    };
  }
  const status = body?.status ?? "Call";
  return {
    kind: "syncing",
    id: item.id,
    title: `Log call · ${name}`,
    meta: `Status: ${status}`,
    uiStatus: item.uiStatus,
  };
}

export function TabletLanding(props: Props) {
  return (
    <RecentCaseNotesProvider>
      <TabletLandingInner {...props} />
    </RecentCaseNotesProvider>
  );
}

function TabletLandingInner({
  initialCaseloadItems,
  caseloadCount,
  specialistName,
  canLogCaseNotes = false,
}: Props) {
  const outbox = useOutbox();
  const { reconcileCaseNote } = useCaseNoteReconciler();
  const { reconcileRepair } = useRepairReconciler();

  const [quickLogSheet, setQuickLogSheet] = useState<QuickLogSheetState | null>(null);

  const topItem = initialCaseloadItems[0] ?? null;

  const nameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of initialCaseloadItems) {
      if (item.displayName !== null) map.set(item.participantId, item.displayName);
    }
    return map;
  }, [initialCaseloadItems]);

  const handleOpenQuickLog = useCallback((participantId: string) => {
    // Mint the Pattern D key once at open; whichever route the user picks, the
    // Outbox mirror + the in-flight request + the reconnect replay all carry
    // this same key (one IDW_Case_Note__c or one Repair__c).
    setQuickLogSheet({ participantId, idempotencyKey: newIdempotencyKey() });
  }, []);

  const handleQuickLogCaseNote = useCallback(
    async (
      participantId: string,
      idempotencyKey: string,
      input: CreateCaseNoteInput,
    ): Promise<MutationFailure | null> => {
      // `reconcileCaseNote` returns null when the note is confirmed OR safely
      // queued offline — either way the work is captured, so close the sheet.
      const failure = await reconcileCaseNote(participantId, idempotencyKey, input);
      if (failure === null) {
        setQuickLogSheet(null);
        return null;
      }
      return failure;
    },
    [reconcileCaseNote],
  );

  const handleQuickLogRepair = useCallback(
    async (
      participantId: string,
      idempotencyKey: string,
      input: CreateRepairInput,
    ): Promise<MutationFailure | null> => {
      // Same close-on-captured contract as the Case Note route (confirmed OR
      // safely queued offline).
      const failure = await reconcileRepair(participantId, idempotencyKey, input);
      if (failure === null) {
        setQuickLogSheet(null);
        return null;
      }
      return failure;
    },
    [reconcileRepair],
  );

  const rows: ReadonlyArray<PendingRow> = useMemo(
    () => outbox.items.map((item) => buildSyncingRow(item, nameById)),
    [outbox.items, nameById],
  );

  return (
    <main className="min-h-screen bg-[#fafbfc] pb-6" data-variant="tablet">
      <TabletHeader pendingCount={outbox.count} specialistName={specialistName} />
      <TopPriorityCard
        item={topItem}
        onLogNotes={handleOpenQuickLog}
        canLogNotes={canLogCaseNotes}
      />
      <SectionDivider label="Pending sync" />
      {/* Outbox-sourced syncing rows only; `onResolve` is a no-op since the
          server Review-Required rows no longer surface here. */}
      <PendingQueuePanel rows={rows} onResolve={() => {}} />
      <SectionDivider label="Or pick another participant" />
      <CollapsedCaseload
        items={initialCaseloadItems}
        totalCount={caseloadCount}
        canLogCaseNote={canLogCaseNotes}
        onLogCaseNote={handleOpenQuickLog}
      />

      {quickLogSheet !== null && (
        <QuickLogSheet
          participantId={quickLogSheet.participantId}
          displayName={nameById.get(quickLogSheet.participantId) ?? null}
          onCancel={() => setQuickLogSheet(null)}
          onSubmitCaseNote={(input) =>
            handleQuickLogCaseNote(quickLogSheet.participantId, quickLogSheet.idempotencyKey, input)
          }
          onSubmitRepair={(input) =>
            handleQuickLogRepair(quickLogSheet.participantId, quickLogSheet.idempotencyKey, input)
          }
        />
      )}
    </main>
  );
}
