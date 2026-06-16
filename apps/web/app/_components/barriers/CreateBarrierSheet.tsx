"use client";

import { useEffect, useId, useRef, useState } from "react";

import { ActionSheetShell } from "@/components/ui/action-sheet-shell";
import { Button } from "@/components/ui/button";
import { useDeviceVariant } from "@/lib/device";

import { useConnectivity } from "../../_lib/connectivity/context";
import { useDraftStore } from "../../_lib/offline/drafts/store";
import { makeDraftScopeKey } from "../../_lib/offline/drafts/types";
import type { CreateBarrierInput, MutationFailure } from "./types";

interface Props {
  readonly participantId: string;
  // Resolved display name for the subtitle. Falls back to `participantId`
  // (mirrors CaseloadRow's `displayLabel`) only when a name isn't resolved.
  readonly displayName?: string | null;
  // P3C-02 — per-specialist draft scoping (AC #4); see LogCallSheet for the
  // identical contract.
  readonly specialistId: string;
  readonly barrierTypes: ReadonlyArray<string>;
  readonly onCancel: () => void;
  readonly onSubmit: (input: CreateBarrierInput) => Promise<MutationFailure | null>;
}

// F-06 create-Barrier sheet — F-13 single-primary-action: the Type picker is
// the primary affordance, Next Steps long-text is secondary, one Submit.
// VR-12 (unknown Type) and VR-14 (missing Type) render inline beneath the
// Type field; non-field failures (5xx, Salesforce reject) render in a
// banner. No toasts — Pattern A "Don't swallow 4xx errors as 'probably
// fine.'" surfaces the structured-error category from API §9.
//
// Dialog chrome (role, focus trap, Escape, backdrop, device variant) lives
// in `ActionSheetShell`; the variant only re-shapes the footer here (full-
// width stacked CTA on tablet, right-aligned row on laptop).
export function CreateBarrierSheet({
  participantId,
  displayName,
  specialistId,
  barrierTypes,
  onCancel,
  onSubmit,
}: Props) {
  const variant = useDeviceVariant();
  // P3C-03 — desktop iframe surface: visibly disable the Submit button when
  // the BFF heartbeat fails or `navigator.onLine === false` (TR-OFFLINE-2 /
  // BR-67). The tablet PWA surface keeps state pinned at "online", so the
  // shared sheet works unchanged there. Cancel stays enabled — it's a
  // dismiss, not a write.
  const connectivity = useConnectivity();
  const writesBlocked = connectivity === "degraded";
  // P3C-02 — hydrate from the per-specialist draft store; transparent
  // recovery (no banner). See LogCallSheet for the equivalent treatment.
  const draftScopeKey = makeDraftScopeKey(specialistId, participantId);
  const setCreateBarrierDraft = useDraftStore((s) => s.setCreateBarrierDraft);
  const [type, setType] = useState<string>(
    () =>
      useDraftStore.getState().createBarrier[draftScopeKey]?.type ?? "",
  );
  const [description, setDescription] = useState<string>(
    () =>
      useDraftStore.getState().createBarrier[draftScopeKey]?.description ??
      "",
  );
  const [submitting, setSubmitting] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [bannerError, setBannerError] = useState<MutationFailure | null>(null);

  // P3C-02 — mirror form state into the draft store. Cleared by the parent
  // on successful submit (`CaseloadView.handleCreateSubmit`); Cancel is a
  // dismiss, not a discard (AC #2).
  useEffect(() => {
    setCreateBarrierDraft(specialistId, participantId, { type, description });
  }, [
    setCreateBarrierDraft,
    specialistId,
    participantId,
    type,
    description,
  ]);
  const titleId = useId();
  const typeFieldId = useId();
  const descFieldId = useId();
  const fieldErrorId = useId();
  const firstControlRef = useRef<HTMLSelectElement | null>(null);

  useEffect(() => {
    firstControlRef.current?.focus();
  }, []);

  async function handleSubmit(ev: React.FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    setFieldError(null);
    setBannerError(null);

    // VR-14 (Type required) — surface client-side without a round-trip so
    // the empty submission case lands on the same inline-error path the
    // server's Zod rejection would.
    if (type.length === 0) {
      setFieldError("Type is required.");
      return;
    }

    setSubmitting(true);
    const input: CreateBarrierInput =
      description.length > 0 ? { type, description } : { type };
    const failure = await onSubmit(input);
    setSubmitting(false);

    if (failure !== null) {
      if (failure.field === "type") {
        setFieldError(failure.message);
      } else {
        setBannerError(failure);
      }
    }
  }

  const isTablet = variant === "tablet";
  // Tablet: stack full-width with the primary on top (visual hierarchy
  // matches BR-62 / F-13's single-primary-action). Tab order stays
  // Cancel → Submit because Cancel is rendered first in the DOM with
  // `order-2`; CSS `order` does not affect sequential focus navigation.
  const footerClass = isTablet
    ? "flex flex-col gap-2 pt-2"
    : "flex justify-end gap-2 pt-2";
  const primaryClass = isTablet ? "h-14 w-full px-6 text-base order-1" : undefined;
  const secondaryClass = isTablet
    ? "h-14 w-full px-6 text-base order-2"
    : undefined;

  return (
    <ActionSheetShell
      titleId={titleId}
      onCancel={onCancel}
      dismissDisabled={submitting}
    >
      <h2 id={titleId} className="text-lg font-semibold">
        Add Barrier
      </h2>
      <p className="mt-1 text-xs text-muted-foreground">
        Participant {displayName ?? participantId}
      </p>
      <form onSubmit={handleSubmit} className="mt-4 space-y-4">
        <div className="space-y-1">
          <label htmlFor={typeFieldId} className="text-sm font-medium">
            Type
          </label>
          <select
            ref={firstControlRef}
            id={typeFieldId}
            value={type}
            onChange={(e) => setType(e.target.value)}
            aria-describedby={fieldError === null ? undefined : fieldErrorId}
            aria-invalid={fieldError !== null}
            disabled={submitting}
            className="block h-11 w-full rounded-md border bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="">Select a Type…</option>
            {barrierTypes.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          {fieldError !== null && (
            <p id={fieldErrorId} role="alert" className="text-sm text-destructive">
              {fieldError}
            </p>
          )}
        </div>

        <div className="space-y-1">
          <label htmlFor={descFieldId} className="text-sm font-medium">
            Next Steps <span className="text-muted-foreground">(optional)</span>
          </label>
          <textarea
            id={descFieldId}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            disabled={submitting}
            rows={4}
            maxLength={2000}
            className="block w-full rounded-md border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
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
            {submitting ? "Saving…" : "Add Barrier"}
          </Button>
        </div>
      </form>
    </ActionSheetShell>
  );
}
