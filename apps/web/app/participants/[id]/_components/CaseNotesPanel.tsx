"use client";

// Participant-profile Log Case Note entry point. Mirrors RepairsPanel. On a
// successful IDW_Case_Note__c write it publishes an optimistic case note into
// the comms provider so the collapsible "Case note logged at <date>" row appears
// in the activity timeline immediately. When `canMutate` is false (supervisor /
// system_admin) the panel renders nothing — case notes are a write affordance.

import { useCallback, useState } from "react";

import { Button } from "@/components/ui/button";

import { useParticipantComms } from "../../../_components/comms/ParticipantCommsProvider";
import { LogCaseNoteSheet } from "../../../_components/case-notes/LogCaseNoteSheet";
import { useCaseNoteMutation } from "../../../_components/case-notes/useCaseNoteMutation";
import type {
  CreateCaseNoteInput,
  MutationFailure,
} from "../../../_components/case-notes/types";

interface Props {
  readonly participantId: string;
  readonly displayName: string | null;
  readonly canMutate: boolean;
}

export function CaseNotesPanel({ participantId, displayName, canMutate }: Props) {
  const { addCaseNote } = useParticipantComms();
  const { isPending, createCaseNote } = useCaseNoteMutation();
  const [sheetOpen, setSheetOpen] = useState(false);

  const handleSubmit = useCallback(
    async (input: CreateCaseNoteInput): Promise<MutationFailure | null> => {
      const result = await createCaseNote(participantId, input);
      if (result.outcome === "failure") return result.failure;
      const r = result.record;
      addCaseNote({
        caseNoteId: r.caseNoteId,
        participantId: r.participantId,
        participantName: displayName,
        serviceDate: r.serviceDate,
        note: r.note,
        contactType: r.contactType,
        type: r.type,
        status: r.status,
        loggedAt: r.loggedAt,
      });
      setSheetOpen(false);
      return null;
    },
    [createCaseNote, participantId, displayName, addCaseNote],
  );

  if (!canMutate) return null;

  return (
    <section
      aria-labelledby="case-notes-heading"
      className="rounded-lg border bg-card p-4 shadow-sm"
    >
      <div className="flex items-center justify-between gap-2">
        <h2
          id="case-notes-heading"
          className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
        >
          Case notes
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
            Log Case Note
          </Button>
        </div>
      </div>
      <p className="mt-2 text-sm text-muted-foreground">
        Log a case note. It appears on the activity timeline and the caseload
        calendar.
      </p>
      {sheetOpen && (
        <LogCaseNoteSheet
          participantId={participantId}
          displayName={displayName}
          onCancel={() => setSheetOpen(false)}
          onSubmit={handleSubmit}
        />
      )}
    </section>
  );
}
