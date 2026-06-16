"use client";

import { useEffect, useId, useRef, useState } from "react";

import { ActionSheetShell } from "@/components/ui/action-sheet-shell";
import { Button } from "@/components/ui/button";
import { useDeviceVariant } from "@/lib/device";

import { useConnectivity } from "../../_lib/connectivity/context";
import type { CloseBarrierInput, MutationFailure } from "./types";

interface Props {
  readonly participantId: string;
  // Resolved display name for the subtitle. Falls back to `participantId`
  // (mirrors CaseloadRow's `displayLabel`) only when a name isn't resolved.
  readonly displayName?: string | null;
  readonly barrierId: string;
  readonly barrierType: string;
  readonly onCancel: () => void;
  readonly onSubmit: (input: CloseBarrierInput) => Promise<MutationFailure | null>;
}

// F-06 close-Barrier confirmation. VR-13 (already closed) surfaces in the
// inline banner since the field "barrier" maps to the whole resource, not a
// single input. Dialog chrome (role, focus trap, Escape, backdrop) lives in
// `ActionSheetShell`; this component owns confirmation copy + the close
// mutation.
export function CloseBarrierConfirm({
  participantId,
  displayName,
  barrierId,
  barrierType,
  onCancel,
  onSubmit,
}: Props) {
  const variant = useDeviceVariant();
  // P3C-03 — desktop iframe surface: visibly disable Submit when offline
  // (TR-OFFLINE-2 / BR-67). No-op on tablet PWA (state pinned to "online").
  const connectivity = useConnectivity();
  const writesBlocked = connectivity === "degraded";
  const [closureReason, setClosureReason] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [bannerError, setBannerError] = useState<MutationFailure | null>(null);
  const titleId = useId();
  const reasonFieldId = useId();
  const submitRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    submitRef.current?.focus();
  }, []);

  async function handleSubmit(ev: React.FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    setBannerError(null);
    setSubmitting(true);
    const input: CloseBarrierInput =
      closureReason.length > 0 ? { barrierId, closureReason } : { barrierId };
    const failure = await onSubmit(input);
    setSubmitting(false);
    if (failure !== null) setBannerError(failure);
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
        Close Barrier
      </h2>
      <p className="mt-1 text-sm">
        <span className="font-medium">{barrierType}</span>
      </p>
      <p className="text-xs text-muted-foreground">
        Participant {displayName ?? participantId}
      </p>
      <form onSubmit={handleSubmit} className="mt-4 space-y-4">
        <div className="space-y-1">
          <label htmlFor={reasonFieldId} className="text-sm font-medium">
            Closure reason{" "}
            <span className="text-muted-foreground">(optional)</span>
          </label>
          <textarea
            id={reasonFieldId}
            value={closureReason}
            onChange={(e) => setClosureReason(e.target.value)}
            disabled={submitting}
            rows={3}
            maxLength={500}
            className="block w-full rounded-md border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>

        {bannerError !== null && (
          <div
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            <p>
              {bannerError.reason === "already_closed"
                ? "This Barrier is already closed."
                : bannerError.message}
            </p>
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
            ref={submitRef}
            type="submit"
            disabled={submitting || writesBlocked}
            title={writesBlocked ? "Offline — Write Access Suspended" : undefined}
            className={primaryClass}
          >
            {submitting ? "Closing…" : "Close Barrier"}
          </Button>
        </div>
      </form>
    </ActionSheetShell>
  );
}
