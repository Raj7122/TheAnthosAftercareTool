"use client";

import { useEffect, useId, useRef, useState } from "react";

import { ActionSheetShell } from "@/components/ui/action-sheet-shell";
import { Button } from "@/components/ui/button";
import { useDeviceVariant } from "@/lib/device";

import { useConnectivity } from "../../_lib/connectivity/context";
import {
  CONTACT_TYPE_OPTIONS,
  STATUS_OPTIONS,
  TYPE_OPTIONS,
  type CreateCaseNoteInput,
  type MutationFailure,
} from "./types";

interface Props {
  readonly participantId: string;
  // Resolved display name for the subtitle. Falls back to `participantId`
  // (mirrors CaseloadRow's `displayLabel`) only when a name isn't resolved.
  readonly displayName?: string | null;
  readonly onCancel: () => void;
  readonly onSubmit: (
    input: CreateCaseNoteInput,
  ) => Promise<MutationFailure | null>;
}

// Log Case Note sheet — F-13 single-primary-action: the note is the primary
// affordance; Contact type / Type / Status pickers route the SF fields, one
// Submit. Writes a real IDW_Case_Note__c via the direct Program_Enrollment__c
// link. Dialog chrome lives in `ActionSheetShell`.
export function LogCaseNoteSheet({
  participantId,
  displayName,
  onCancel,
  onSubmit,
}: Props) {
  const variant = useDeviceVariant();
  const connectivity = useConnectivity();
  const writesBlocked = connectivity === "degraded";

  const [note, setNote] = useState("");
  // Sensible defaults so submit is one tap.
  const [contactType, setContactType] = useState<string>("Phone");
  const [type, setType] = useState<string>("Check In");
  const [status, setStatus] = useState<string>("Completed");
  const [submitting, setSubmitting] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [bannerError, setBannerError] = useState<MutationFailure | null>(null);

  const titleId = useId();
  const noteFieldId = useId();
  const contactFieldId = useId();
  const typeFieldId = useId();
  const statusFieldId = useId();
  const fieldErrorId = useId();
  const firstControlRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    firstControlRef.current?.focus();
  }, []);

  async function handleSubmit(ev: React.FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    setFieldError(null);
    setBannerError(null);

    if (note.trim().length === 0) {
      setFieldError("A case note is required.");
      return;
    }

    setSubmitting(true);
    const failure = await onSubmit({
      note: note.trim(),
      contactType,
      type,
      status,
    });
    setSubmitting(false);

    if (failure !== null) {
      if (failure.field === "note") {
        setFieldError(failure.message);
      } else {
        setBannerError(failure);
      }
    }
  }

  const isTablet = variant === "tablet";
  const footerClass = isTablet
    ? "flex flex-col gap-2 pt-2"
    : "flex justify-end gap-2 pt-2";
  const primaryClass = isTablet ? "h-14 w-full px-6 text-base order-1" : undefined;
  const secondaryClass = isTablet
    ? "h-14 w-full px-6 text-base order-2"
    : undefined;
  const selectClass =
    "block h-11 w-full rounded-md border bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

  return (
    <ActionSheetShell
      titleId={titleId}
      onCancel={onCancel}
      dismissDisabled={submitting}
    >
      <h2 id={titleId} className="text-lg font-semibold">
        Log Case Note
      </h2>
      <p className="mt-1 text-xs text-muted-foreground">
        Participant {displayName ?? participantId}
      </p>
      <form onSubmit={handleSubmit} className="mt-4 space-y-4">
        <div className="space-y-1">
          <label htmlFor={noteFieldId} className="text-sm font-medium">
            Note
          </label>
          <textarea
            ref={firstControlRef}
            id={noteFieldId}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            aria-describedby={fieldError === null ? undefined : fieldErrorId}
            aria-invalid={fieldError !== null}
            disabled={submitting}
            rows={4}
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

        <div className="space-y-1">
          <label htmlFor={contactFieldId} className="text-sm font-medium">
            Contact type
          </label>
          <select
            id={contactFieldId}
            value={contactType}
            onChange={(e) => setContactType(e.target.value)}
            disabled={submitting}
            className={selectClass}
          >
            {CONTACT_TYPE_OPTIONS.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1">
          <label htmlFor={typeFieldId} className="text-sm font-medium">
            Type
          </label>
          <select
            id={typeFieldId}
            value={type}
            onChange={(e) => setType(e.target.value)}
            disabled={submitting}
            className={selectClass}
          >
            {TYPE_OPTIONS.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1">
          <label htmlFor={statusFieldId} className="text-sm font-medium">
            Status
          </label>
          <select
            id={statusFieldId}
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            disabled={submitting}
            className={selectClass}
          >
            {STATUS_OPTIONS.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
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

        <div className={footerClass}>
          <Button
            type="button"
            variant="outline"
            onClick={onCancel}
            disabled={submitting}
            className={secondaryClass}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={submitting || writesBlocked}
            title={writesBlocked ? "Offline — Write Access Suspended" : undefined}
            className={primaryClass}
          >
            {submitting ? "Saving…" : "Log Case Note"}
          </Button>
        </div>
      </form>
    </ActionSheetShell>
  );
}
