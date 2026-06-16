"use client";

import { useEffect, useId, useRef, useState } from "react";

import { ActionSheetShell } from "@/components/ui/action-sheet-shell";
import { Button } from "@/components/ui/button";

import { useConnectivity } from "../../_lib/connectivity/context";
import type {
  CreateCaseNoteInput,
  MutationFailure,
} from "../../_components/case-notes/types";
import type { CreateRepairInput } from "../../_components/repairs/types";

// Quick Log sheet (P3B-06) — the tablet field-capture surface. One textarea,
// one route toggle, one Send (F-13 single-primary-action / BR-62). A specialist
// taps the 📝 action, picks where the note lands — Case Note (IDW_Case_Note__c)
// or Repair (Repair__c) — dictates into the note, and sends. Both routes are
// offline-resilient via the Outbox mirror (the parent wires the reconcilers).
//
// "Just Notes" by design: the Case Note route submits sensible server defaults
// (Phone / Check In / Completed) rather than surfacing the Contact type / Type /
// Status pickers — the desktop sheets keep those. The note field is
// dictation-compatible (platform keyboard mic key; F-19/ADR-08) — there is NO
// in-app microphone or audio path here. Dialog chrome lives in
// `ActionSheetShell`.
//
// Tablet-only: the shared desktop `LogCaseNoteSheet` + `CreateRepairSheet`
// remain unchanged for the caseload / participant-profile surfaces.

type QuickLogRoute = "case_note" | "repair";

// Defaults the Case Note route submits in lieu of the full picklists (verified
// IDW_Case_Note__c picklist values; the server re-validates).
const CASE_NOTE_DEFAULTS = {
  contactType: "Phone",
  type: "Check In",
  status: "Completed",
} as const;

interface Props {
  readonly participantId: string;
  // Resolved display name for the subtitle. Falls back to `participantId`
  // (mirrors CaseloadRow's `displayLabel`) only when a name isn't resolved.
  readonly displayName?: string | null;
  readonly onCancel: () => void;
  readonly onSubmitCaseNote: (
    input: CreateCaseNoteInput,
  ) => Promise<MutationFailure | null>;
  readonly onSubmitRepair: (
    input: CreateRepairInput,
  ) => Promise<MutationFailure | null>;
}

export function QuickLogSheet({
  participantId,
  displayName,
  onCancel,
  onSubmitCaseNote,
  onSubmitRepair,
}: Props) {
  const connectivity = useConnectivity();
  const writesBlocked = connectivity === "degraded";

  const [route, setRoute] = useState<QuickLogRoute>("case_note");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [bannerError, setBannerError] = useState<MutationFailure | null>(null);

  const titleId = useId();
  const noteFieldId = useId();
  const fieldErrorId = useId();
  const firstControlRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    firstControlRef.current?.focus();
  }, []);

  // Switching route must NOT clear the typed note — only stale validation copy.
  function selectRoute(next: QuickLogRoute) {
    if (next === route) return;
    setRoute(next);
    setFieldError(null);
    setBannerError(null);
  }

  async function handleSubmit(ev: React.FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    setFieldError(null);
    setBannerError(null);

    const trimmed = note.trim();
    if (trimmed.length === 0) {
      setFieldError(
        route === "case_note"
          ? "A case note is required."
          : "A repair note is required.",
      );
      return;
    }

    setSubmitting(true);
    const failure =
      route === "case_note"
        ? await onSubmitCaseNote({ note: trimmed, ...CASE_NOTE_DEFAULTS })
        : await onSubmitRepair({ note: trimmed });
    setSubmitting(false);

    if (failure !== null) {
      if (failure.field === "note") {
        setFieldError(failure.message);
      } else {
        setBannerError(failure);
      }
    }
  }

  const isCaseNote = route === "case_note";

  // Two-button segmented control. Full-width pill, generous tap targets; the
  // selected route reads as a filled segment, the other as a quiet one.
  const segmentBase =
    "flex-1 h-11 rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
  const segmentOn = "bg-primary text-primary-foreground";
  const segmentOff = "text-muted-foreground hover:bg-background";

  return (
    <ActionSheetShell
      titleId={titleId}
      onCancel={onCancel}
      dismissDisabled={submitting}
    >
      <h2 id={titleId} className="text-lg font-semibold">
        Log Note
      </h2>
      <p className="mt-1 text-xs text-muted-foreground">
        Participant {displayName ?? participantId}
      </p>
      <form onSubmit={handleSubmit} className="mt-4 space-y-4">
        <div
          role="radiogroup"
          aria-label="Where to log this note"
          className="flex gap-1 rounded-lg border bg-muted p-1"
        >
          <button
            type="button"
            role="radio"
            aria-checked={isCaseNote}
            onClick={() => selectRoute("case_note")}
            disabled={submitting}
            className={`${segmentBase} ${isCaseNote ? segmentOn : segmentOff}`}
          >
            Case Note
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={!isCaseNote}
            onClick={() => selectRoute("repair")}
            disabled={submitting}
            className={`${segmentBase} ${!isCaseNote ? segmentOn : segmentOff}`}
          >
            Repair
          </button>
        </div>

        <div className="space-y-1">
          <label htmlFor={noteFieldId} className="text-sm font-medium">
            Notes
          </label>
          <textarea
            ref={firstControlRef}
            id={noteFieldId}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            aria-describedby={fieldError === null ? undefined : fieldErrorId}
            aria-invalid={fieldError !== null}
            disabled={submitting}
            rows={5}
            maxLength={32000}
            inputMode="text"
            autoCapitalize="sentences"
            className="block w-full rounded-md border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          {fieldError !== null && (
            <p id={fieldErrorId} role="alert" className="text-sm text-destructive">
              {fieldError}
            </p>
          )}
        </div>

        {bannerError !== null && (
          <div
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            <p>{bannerError.message}</p>
            {bannerError.traceId !== null && (
              <p className="mt-1 font-mono text-xs opacity-75">
                trace {bannerError.traceId}
              </p>
            )}
          </div>
        )}

        <div className="flex flex-col gap-2 pt-2">
          <Button
            type="submit"
            disabled={submitting || writesBlocked}
            title={writesBlocked ? "Offline — Write Access Suspended" : undefined}
            className="h-14 w-full px-6 text-base order-1"
          >
            {submitting ? "Saving…" : "Send"}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={onCancel}
            disabled={submitting}
            className="h-14 w-full px-6 text-base order-2"
          >
            Cancel
          </Button>
        </div>
      </form>
    </ActionSheetShell>
  );
}
