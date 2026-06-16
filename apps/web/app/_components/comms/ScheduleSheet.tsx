"use client";

import { useEffect, useId, useRef, useState } from "react";

import { ActionSheetShell } from "@/components/ui/action-sheet-shell";
import { Button } from "@/components/ui/button";
import { useDeviceVariant } from "@/lib/device";

import type { MutationFailure } from "../../caseload/_lib/send-mutation";
import { useDraftStore } from "../../_lib/offline/drafts/store";
import { makeDraftScopeKey } from "../../_lib/offline/drafts/types";
import { formatLocalYyyyMmDd } from "../../caseload/_lib/log-call-validation";

// P1H-11 schedule-visit sheet — WIRED to E-13 (POST /participants/:id/visits).
// The visit persists as a Salesforce Case Note (Type='Stability Meeting',
// Status='Scheduled'); the Outlook calendar invite is degraded in this
// environment (no MS Graph creds), which the sheet notes up front. `onSend`
// resolves to a MutationFailure to render inline (sheet stays open) or null on
// success (parent closes).
export const VISIT_TYPE_OPTIONS = [
  "Stability visit",
  "Check-in visit",
  "Home visit",
] as const;

export type VisitType = (typeof VISIT_TYPE_OPTIONS)[number];

const DEFAULT_VISIT_TYPE: VisitType = "Stability visit";

interface Props {
  readonly participantId: string;
  readonly specialistId: string;
  readonly displayName: string | null;
  readonly onCancel: () => void;
  // Returns a failure to render inline, or null on success (parent closes).
  readonly onSend: (visit: {
    readonly date: string;
    readonly type: string;
    readonly notes: string;
  }) => Promise<MutationFailure | null>;
}

export function ScheduleSheet({
  participantId,
  specialistId,
  displayName,
  onCancel,
  onSend,
}: Props) {
  const variant = useDeviceVariant();
  const isTablet = variant === "tablet";
  const draftScopeKey = makeDraftScopeKey(specialistId, participantId);
  const setScheduleVisitDraft = useDraftStore((s) => s.setScheduleVisitDraft);

  const [visitDate, setVisitDate] = useState<string>(
    () =>
      useDraftStore.getState().scheduleVisit[draftScopeKey]?.visitDate ??
      formatLocalYyyyMmDd(new Date()),
  );
  const [visitType, setVisitType] = useState<string>(
    () =>
      useDraftStore.getState().scheduleVisit[draftScopeKey]?.visitType ??
      DEFAULT_VISIT_TYPE,
  );
  const [notes, setNotes] = useState<string>(
    () => useDraftStore.getState().scheduleVisit[draftScopeKey]?.notes ?? "",
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<MutationFailure | null>(null);

  useEffect(() => {
    setScheduleVisitDraft(specialistId, participantId, {
      visitDate,
      visitType,
      notes,
    });
  }, [setScheduleVisitDraft, specialistId, participantId, visitDate, visitType, notes]);

  const titleId = useId();
  const dateFieldId = useId();
  const typeFieldId = useId();
  const notesFieldId = useId();

  const firstControlRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    firstControlRef.current?.focus();
  }, []);

  async function handleSubmit(ev: React.FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    setSubmitting(true);
    setError(null);
    const failure = await onSend({ date: visitDate, type: visitType, notes });
    if (failure !== null) {
      setError(failure);
      setSubmitting(false);
    }
    // On success the parent unmounts this sheet (and clears the draft).
  }

  const footerClass = isTablet
    ? "flex flex-col gap-2 pt-2"
    : "flex justify-end gap-2 pt-2";
  const primaryClass = isTablet ? "h-14 w-full px-6 text-base order-1" : undefined;
  const secondaryClass = isTablet
    ? "h-14 w-full px-6 text-base order-2"
    : undefined;

  const sendDisabled = visitDate.trim().length === 0 || submitting;

  return (
    <ActionSheetShell titleId={titleId} onCancel={onCancel}>
      <h2 id={titleId} className="text-lg font-semibold">
        Schedule visit
      </h2>
      {displayName !== null && (
        <p className="mt-1 text-xs text-muted-foreground">
          For <span className="font-medium text-foreground">{displayName}</span>
        </p>
      )}
      <form onSubmit={handleSubmit} className="mt-4 space-y-4">
        <div className="space-y-1">
          <label htmlFor={dateFieldId} className="text-sm font-medium">
            Visit date
          </label>
          <input
            ref={firstControlRef}
            id={dateFieldId}
            type="date"
            value={visitDate}
            onChange={(e) => setVisitDate(e.target.value)}
            className={selectClass}
          />
        </div>

        <div className="space-y-1">
          <label htmlFor={typeFieldId} className="text-sm font-medium">
            Visit type
          </label>
          <select
            id={typeFieldId}
            value={visitType}
            onChange={(e) => setVisitType(e.target.value)}
            className={selectClass}
          >
            {VISIT_TYPE_OPTIONS.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1">
          <label htmlFor={notesFieldId} className="text-sm font-medium">
            Notes <span className="text-muted-foreground">(optional)</span>
          </label>
          <textarea
            id={notesFieldId}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            className="block w-full rounded-md border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>

        <p className="text-xs text-muted-foreground">
          Saved to Salesforce as a scheduled Stability Visit. Outlook calendar
          sync isn’t enabled in this environment.
        </p>

        {error !== null && (
          <div
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
          >
            {error.message}
          </div>
        )}

        <div className={footerClass}>
          <Button
            type="button"
            variant="outline"
            onClick={onCancel}
            className={secondaryClass}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={sendDisabled} className={primaryClass}>
            {submitting ? "Scheduling…" : "Schedule visit"}
          </Button>
        </div>
      </form>
    </ActionSheetShell>
  );
}

const selectClass =
  "block h-11 w-full rounded-md border bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
