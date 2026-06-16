"use client";

// Participant-profile Add Repair entry point. NET-NEW / off-spec (demo-driven),
// mirroring BarriersPanel's header-button + sheet pattern. On a successful
// Repair__c write it publishes an optimistic repair into the comms provider so
// the collapsible "Repair logged at <date>" row appears in the activity timeline
// immediately. When `canMutate` is false (supervisor / system_admin) the panel
// renders nothing — repairs are a write affordance.

import { useCallback, useState } from "react";

import { Button } from "@/components/ui/button";

import { useParticipantComms } from "../../../_components/comms/ParticipantCommsProvider";
import { CreateRepairSheet } from "../../../_components/repairs/CreateRepairSheet";
import { useRepairMutation } from "../../../_components/repairs/useRepairMutation";
import type {
  CreateRepairInput,
  MutationFailure,
} from "../../../_components/repairs/types";

interface Props {
  readonly participantId: string;
  readonly displayName: string | null;
  readonly canMutate: boolean;
}

export function RepairsPanel({ participantId, displayName, canMutate }: Props) {
  const { addRepair } = useParticipantComms();
  const { isPending, createRepair } = useRepairMutation();
  const [sheetOpen, setSheetOpen] = useState(false);

  const handleSubmit = useCallback(
    async (input: CreateRepairInput): Promise<MutationFailure | null> => {
      const result = await createRepair(participantId, input);
      if (result.outcome === "failure") return result.failure;
      const r = result.record;
      addRepair({
        repairId: r.repairId,
        participantId: r.participantId,
        participantName: displayName,
        identificationDate: r.identificationDate,
        note: r.note,
        loggedAt: r.loggedAt,
      });
      setSheetOpen(false);
      return null;
    },
    [createRepair, participantId, displayName, addRepair],
  );

  if (!canMutate) return null;

  return (
    <section
      aria-labelledby="repairs-heading"
      className="rounded-lg border bg-card p-4 shadow-sm"
    >
      <div className="flex items-center justify-between gap-2">
        <h2
          id="repairs-heading"
          className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
        >
          Repairs
        </h2>
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
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setSheetOpen(true)}
          >
            Add Repair
          </Button>
        </div>
      </div>
      <p className="mt-2 text-sm text-muted-foreground">
        Log a repair note. It appears on the activity timeline and the caseload
        calendar.
      </p>
      {sheetOpen && (
        <CreateRepairSheet
          participantId={participantId}
          displayName={displayName}
          onCancel={() => setSheetOpen(false)}
          onSubmit={handleSubmit}
        />
      )}
    </section>
  );
}
