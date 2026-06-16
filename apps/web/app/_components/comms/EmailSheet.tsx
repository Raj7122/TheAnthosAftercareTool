"use client";

import { useEffect, useId, useRef, useState } from "react";

import { ActionSheetShell } from "@/components/ui/action-sheet-shell";
import { Button } from "@/components/ui/button";
import { useDeviceVariant } from "@/lib/device";

import type { MutationFailure } from "../../caseload/_lib/send-mutation";
import { useDraftStore } from "../../_lib/offline/drafts/store";
import { makeDraftScopeKey } from "../../_lib/offline/drafts/types";
import {
  DEFAULT_TEMPLATE_KEY,
  EMAIL_TEMPLATES,
  TEMPLATE_OPTIONS,
  applyTemplate,
  deriveFirstName,
  type TemplateKey,
} from "../../_lib/comms/templates";

// P1H-11 email compose sheet — WIRED to E-12 (POST /participants/:id/emails via
// a tool-owned Salesforce Flow). `onSend` performs the real send and resolves
// to a MutationFailure to render inline (sheet stays open) or null on success
// (parent closes). The `{{firstName}}` token is a demo-only client-side swap;
// the authoritative templating happens in the Salesforce Flow.
interface Props {
  readonly participantId: string;
  readonly specialistId: string;
  readonly displayName: string | null;
  readonly email: string | null;
  readonly onCancel: () => void;
  // Returns a failure to render inline, or null on success (parent closes).
  readonly onSend: (subject: string, body: string) => Promise<MutationFailure | null>;
}

export function EmailSheet({
  participantId,
  specialistId,
  displayName,
  email,
  onCancel,
  onSend,
}: Props) {
  const variant = useDeviceVariant();
  const isTablet = variant === "tablet";
  const draftScopeKey = makeDraftScopeKey(specialistId, participantId);
  const setEmailComposeDraft = useDraftStore((s) => s.setEmailComposeDraft);
  const firstName = deriveFirstName(displayName);

  const [templateKey, setTemplateKey] =
    useState<TemplateKey>(DEFAULT_TEMPLATE_KEY);
  const [subject, setSubject] = useState<string>(
    () =>
      useDraftStore.getState().emailCompose[draftScopeKey]?.subject ??
      applyTemplate(EMAIL_TEMPLATES[DEFAULT_TEMPLATE_KEY].subject, firstName),
  );
  const [body, setBody] = useState<string>(
    () =>
      useDraftStore.getState().emailCompose[draftScopeKey]?.body ??
      applyTemplate(EMAIL_TEMPLATES[DEFAULT_TEMPLATE_KEY].body, firstName),
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<MutationFailure | null>(null);

  useEffect(() => {
    setEmailComposeDraft(specialistId, participantId, { subject, body });
  }, [setEmailComposeDraft, specialistId, participantId, subject, body]);

  const titleId = useId();
  const templateFieldId = useId();
  const subjectFieldId = useId();
  const bodyFieldId = useId();

  const firstControlRef = useRef<HTMLSelectElement | null>(null);
  useEffect(() => {
    firstControlRef.current?.focus();
  }, []);

  function selectTemplate(next: TemplateKey) {
    setTemplateKey(next);
    setSubject(applyTemplate(EMAIL_TEMPLATES[next].subject, firstName));
    setBody(applyTemplate(EMAIL_TEMPLATES[next].body, firstName));
  }

  async function handleSubmit(ev: React.FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    setSubmitting(true);
    setError(null);
    const failure = await onSend(subject, body);
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

  const sendDisabled =
    subject.trim().length === 0 || body.trim().length === 0 || submitting;

  return (
    <ActionSheetShell titleId={titleId} onCancel={onCancel}>
      <h2 id={titleId} className="text-lg font-semibold">
        Send email
      </h2>
      <p className="mt-1 text-xs text-muted-foreground">
        To{" "}
        <span className="font-medium text-foreground">
          {displayName ?? email ?? "—"}
        </span>
        {displayName !== null && email !== null && (
          <span> · {email}</span>
        )}
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
          <label htmlFor={subjectFieldId} className="text-sm font-medium">
            Subject
          </label>
          <input
            id={subjectFieldId}
            type="text"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            className={selectClass}
          />
        </div>

        <div className="space-y-1">
          <label htmlFor={bodyFieldId} className="text-sm font-medium">
            Message
          </label>
          <textarea
            id={bodyFieldId}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={8}
            inputMode="text"
            autoCapitalize="sentences"
            className="block w-full rounded-md border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <p className="text-xs text-muted-foreground">
            Edit the message before sending.
          </p>
        </div>

        {error !== null && (
          <div
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
          >
            {error.code === "EMAIL_NOT_CONFIGURED"
              ? "Email sending isn’t enabled yet (the Salesforce email Flow is not deployed)."
              : error.message}
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
            {submitting ? "Sending…" : "Send email"}
          </Button>
        </div>
      </form>
    </ActionSheetShell>
  );
}

const selectClass =
  "block h-11 w-full rounded-md border bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
