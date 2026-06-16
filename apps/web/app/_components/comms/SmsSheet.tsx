"use client";

import { useEffect, useId, useRef, useState } from "react";

import { ActionSheetShell } from "@/components/ui/action-sheet-shell";
import { Button } from "@/components/ui/button";
import { useDeviceVariant } from "@/lib/device";

import type { MutationFailure } from "../../caseload/_lib/send-mutation";
import { useDraftStore } from "../../_lib/offline/drafts/store";
import { makeDraftScopeKey } from "../../_lib/offline/drafts/types";
import { maskPhone } from "../../participants/[id]/_lib/mask-phone";
import {
  DEFAULT_TEMPLATE_KEY,
  SMS_TEMPLATES,
  TEMPLATE_OPTIONS,
  type TemplateKey,
} from "../../_lib/comms/templates";
import {
  QUIET_HOURS_WARNING,
  isInQuietHours,
} from "../../_lib/comms/quiet-hours";

// P1H-11 SMS compose sheet — WIRED to E-11 (POST /participants/:id/sms via
// Mogli). `onSend` performs the real send and resolves to a MutationFailure to
// render inline (the sheet stays open) or null on success (the parent closes
// it). The server is authoritative on quiet hours: a QUIET_HOURS_BLOCKED 409
// surfaces here with a one-tap "Schedule for the next window" affordance that
// re-submits with `scheduledFor`. `isInQuietHours` remains a soft pre-warning.
interface Props {
  readonly participantId: string;
  readonly specialistId: string;
  readonly displayName: string | null;
  readonly phone: string | null;
  readonly onCancel: () => void;
  // Returns a failure to render inline, or null on success (parent closes).
  // `scheduledFor` (ISO) is set on the quiet-hours reschedule path.
  readonly onSend: (
    body: string,
    scheduledFor?: string,
  ) => Promise<MutationFailure | null>;
}

export function SmsSheet({
  participantId,
  specialistId,
  displayName,
  phone,
  onCancel,
  onSend,
}: Props) {
  const variant = useDeviceVariant();
  const isTablet = variant === "tablet";
  const draftScopeKey = makeDraftScopeKey(specialistId, participantId);
  const setSmsComposeDraft = useDraftStore((s) => s.setSmsComposeDraft);

  const [templateKey, setTemplateKey] = useState<TemplateKey>(DEFAULT_TEMPLATE_KEY);
  const [body, setBody] = useState<string>(
    () =>
      useDraftStore.getState().smsCompose[draftScopeKey]?.body ??
      SMS_TEMPLATES[DEFAULT_TEMPLATE_KEY],
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<MutationFailure | null>(null);

  useEffect(() => {
    setSmsComposeDraft(specialistId, participantId, { body });
  }, [setSmsComposeDraft, specialistId, participantId, body]);

  const titleId = useId();
  const templateFieldId = useId();
  const bodyFieldId = useId();

  const firstControlRef = useRef<HTMLSelectElement | null>(null);
  useEffect(() => {
    firstControlRef.current?.focus();
  }, []);

  const quietHours = isInQuietHours(new Date());

  function selectTemplate(next: TemplateKey) {
    setTemplateKey(next);
    setBody(SMS_TEMPLATES[next]);
  }

  async function submit(scheduledFor?: string) {
    setSubmitting(true);
    setError(null);
    const failure = await onSend(body, scheduledFor);
    if (failure !== null) {
      setError(failure);
      setSubmitting(false);
    }
    // On success the parent unmounts this sheet — no state reset needed.
  }

  function handleSubmit(ev: React.FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    void submit();
  }

  const footerClass = isTablet ? "flex flex-col gap-2 pt-2" : "flex justify-end gap-2 pt-2";
  const primaryClass = isTablet ? "h-14 w-full px-6 text-base order-1" : undefined;
  const secondaryClass = isTablet ? "h-14 w-full px-6 text-base order-2" : undefined;

  const sendDisabled = body.trim().length === 0 || submitting;
  const quietHoursBlocked = error?.code === "QUIET_HOURS_BLOCKED";
  const nextWindow = error?.nextAllowedWindowStart;

  return (
    <ActionSheetShell titleId={titleId} onCancel={onCancel}>
      <h2 id={titleId} className="text-lg font-semibold">
        Send SMS
      </h2>
      <p className="mt-1 text-xs text-muted-foreground">
        To{" "}
        <span className="font-medium text-foreground">
          {displayName ?? maskPhone(phone)}
        </span>
        {displayName !== null && <span> · {maskPhone(phone)}</span>}
      </p>
      <form onSubmit={handleSubmit} className="mt-4 space-y-4">
        <div className="space-y-1">
          <label htmlFor={templateFieldId} className="text-sm font-medium">
            Template
          </label>
          <select
            ref={firstControlRef}
            id={templateFieldId}
            value={templateKey}
            onChange={(e) => selectTemplate(e.target.value as TemplateKey)}
            className={selectClass}
          >
            {TEMPLATE_OPTIONS.map((opt) => (
              <option key={opt.key} value={opt.key}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1">
          <div className="flex items-baseline justify-between">
            <label htmlFor={bodyFieldId} className="text-sm font-medium">
              Message
            </label>
            <span className="text-xs tabular-nums text-muted-foreground">
              {body.length} chars
            </span>
          </div>
          <textarea
            id={bodyFieldId}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={4}
            inputMode="text"
            autoCapitalize="sentences"
            className="block w-full rounded-md border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <p className="text-xs text-muted-foreground">Edit the message before sending.</p>
        </div>

        {quietHours && !quietHoursBlocked && (
          <div
            role="note"
            className="rounded-md border border-amber-400/50 bg-amber-50 px-3 py-2 text-sm text-amber-800"
          >
            {QUIET_HOURS_WARNING}
          </div>
        )}

        {error !== null && (
          <div
            role="alert"
            className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
          >
            <p>
              {quietHoursBlocked
                ? "Quiet hours are in effect for this participant (9 PM–8 AM local). SMS can be scheduled for the next allowed window."
                : error.message}
            </p>
            {quietHoursBlocked && nextWindow !== undefined && (
              <Button
                type="button"
                variant="outline"
                disabled={submitting}
                onClick={() => void submit(nextWindow)}
              >
                Schedule for {new Date(nextWindow).toLocaleString()}
              </Button>
            )}
          </div>
        )}

        <div className={footerClass}>
          <Button type="button" variant="outline" onClick={onCancel} className={secondaryClass}>
            Cancel
          </Button>
          <Button type="submit" disabled={sendDisabled} className={primaryClass}>
            {submitting ? "Sending…" : "Send SMS"}
          </Button>
        </div>
      </form>
    </ActionSheetShell>
  );
}

const selectClass =
  "block h-11 w-full rounded-md border bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
