"use client";

// F-07 Barriers panel orchestrator (P1E-04b). Owns the create / close sheet
// state, calls `useParticipantBarrierMutations` for the Pattern A
// optimistic-UI round-trip, and renders `OpenBarriersList` with the per-row
// Close affordance + header Add affordance bound. When `canMutate` is
// false (BR-35/36 — supervisor or system_admin) the panel renders the same
// read-only list the P1F-08 shell did, with no affordances.

import { useCallback, useState } from "react";

import type { CaseloadOpenBarrier, ParticipantDetailBody } from "@anthos/api";

import { Button } from "@/components/ui/button";

import { CloseBarrierConfirm } from "../../../_components/barriers/CloseBarrierConfirm";
import { CreateBarrierSheet } from "../../../_components/barriers/CreateBarrierSheet";
import type {
  CloseBarrierInput,
  CreateBarrierInput,
  MutationFailure,
} from "../../../_components/barriers/types";
import { useParticipantBarrierMutations } from "../_lib/useParticipantBarrierMutations";
import {
  useDraftStore,
  useDraftStoreSync,
} from "../../../_lib/offline/drafts/store";
import { OpenBarriersList } from "./OpenBarriersList";

interface Props {
  readonly initialBody: ParticipantDetailBody;
  readonly barrierTypes: ReadonlyArray<string>;
  readonly canMutate: boolean;
  // P3C-02 — per-specialist draft scoping for the embedded F-06
  // create-Barrier sheet (AC #4). Mirrors CaseloadView's threading.
  readonly specialistId: string;
}

export function BarriersPanel({
  initialBody,
  barrierTypes,
  canMutate,
  specialistId,
}: Props) {
  // P3C-02 — participant detail is the second client surface that opens
  // CreateBarrierSheet, so the per-specialist purge has to run here too
  // (a specialist could land directly on /participants/[id] without ever
  // visiting /caseload). `useDraftStoreSync` is idempotent on matching id.
  useDraftStoreSync(specialistId);
  const { body, isPending, closingBarrierIds, createBarrier, closeBarrier } =
    useParticipantBarrierMutations({ initialBody });
  const [createSheetOpen, setCreateSheetOpen] = useState(false);
  const [closeTarget, setCloseTarget] = useState<CaseloadOpenBarrier | null>(
    null,
  );

  const handleCreateSubmit = useCallback(
    async (input: CreateBarrierInput): Promise<MutationFailure | null> => {
      const result = await createBarrier(input);
      if (result.outcome === "failure") return result.failure;
      // P3C-02 — drop the persisted draft on canonical 2xx; same contract
      // as CaseloadView.handleCreateSubmit.
      useDraftStore
        .getState()
        .clearCreateBarrierDraft(specialistId, body.participantId);
      setCreateSheetOpen(false);
      return null;
    },
    [createBarrier, specialistId, body.participantId],
  );

  const handleCloseSubmit = useCallback(
    async (input: CloseBarrierInput): Promise<MutationFailure | null> => {
      const result = await closeBarrier(input);
      if (result.outcome === "failure") return result.failure;
      setCloseTarget(null);
      return null;
    },
    [closeBarrier],
  );

  const headerAction =
    canMutate || isPending ? (
      <div className="flex items-center gap-2">
        {isPending && (
          <span
            role="status"
            aria-live="polite"
            className="text-xs italic text-muted-foreground"
          >
            Saving…
          </span>
        )}
        {canMutate && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setCreateSheetOpen(true)}
          >
            Add Barrier
          </Button>
        )}
      </div>
    ) : undefined;

  return (
    <>
      <OpenBarriersList
        barriers={body.openBarriers}
        {...(canMutate && {
          onCloseBarrier: (b: CaseloadOpenBarrier) => setCloseTarget(b),
          closingBarrierIds,
        })}
        {...(headerAction !== undefined && { headerAction })}
      />
      {canMutate && createSheetOpen && (
        <CreateBarrierSheet
          participantId={body.participantId}
          displayName={body.displayName}
          specialistId={specialistId}
          barrierTypes={barrierTypes}
          onCancel={() => setCreateSheetOpen(false)}
          onSubmit={handleCreateSubmit}
        />
      )}
      {canMutate && closeTarget && (
        <CloseBarrierConfirm
          participantId={body.participantId}
          displayName={body.displayName}
          barrierId={closeTarget.barrierId}
          barrierType={closeTarget.type ?? "Unclassified"}
          onCancel={() => setCloseTarget(null)}
          onSubmit={handleCloseSubmit}
        />
      )}
    </>
  );
}
