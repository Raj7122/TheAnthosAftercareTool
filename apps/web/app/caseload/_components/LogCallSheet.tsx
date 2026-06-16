"use client";

import { useEffect, useId, useRef, useState } from "react";

import type { LogCallStatus, LogCallType } from "@anthos/api";

import { ActionSheetShell } from "@/components/ui/action-sheet-shell";
import { Button } from "@/components/ui/button";
import { useDeviceVariant } from "@/lib/device";

import { useConnectivity } from "../../_lib/connectivity/context";
import { useDraftStore } from "../../_lib/offline/drafts/store";
import { makeDraftScopeKey } from "../../_lib/offline/drafts/types";
import {
  LOG_CALL_DEFAULT_STATUS,
  LOG_CALL_DEFAULT_TYPE,
  LOG_CALL_STATUS_OPTIONS,
  LOG_CALL_TYPE_OPTIONS,
  SUMMARY_MAX_LEN,
  SUMMARY_MIN_LEN_COMPLETED,
} from "../_lib/log-call-enums";
import {
  computeServiceDateBounds,
  formatLocalYyyyMmDd,
  hasAnyError,
  mapFailureToFields,
  validate,
  type FieldErrors,
} from "../_lib/log-call-validation";
import type { LogCallInput } from "../_lib/useLogCallMutation";
import type { MutationFailure } from "../_lib/send-mutation";

interface Props {
  readonly participantId: string;
  // Resolved display name for the subtitle + submit-button label. Falls back
  // to `participantId` (mirrors CaseloadRow's `displayLabel`) only when a name
  // isn't resolved.
  readonly displayName?: string | null;
  // P3C-02 — required for per-specialist draft scoping (AC #4). The store
  // partitions drafts by `${specialistId}:${participantId}` so a session
  // hand-off can purge other specialists' in-flight drafts.
  readonly specialistId: string;
  // The Pattern D key is generated once at sheet-open time in the parent's
  // state initializer (see `CaseloadView.handleOpenLogCall`) and passed
  // down here so multiple Submit clicks across a transient 5xx land on the
  // same idempotency row at the BFF. A new key only appears when the sheet
  // is closed and reopened (new parent state object → new initializer run).
  readonly idempotencyKey: string;
  readonly onCancel: () => void;
  readonly onSubmit: (
    input: LogCallInput,
    idempotencyKey: string,
  ) => Promise<MutationFailure | null>;
}

// F-08 Log-a-Call sheet. F-13 single-primary-action: Status is the lead
// affordance (the call's outcome), Type is the secondary picker, Service Date
// + Summary follow, one Submit. The two outcome branches the ticket calls
// "BR-29 / BR-30" (impl-plan shorthand — FS v1.12 BR-29/BR-30 at lines
// 646-647 are F-05 cycle rules, NOT this guard; canonical FS authority is
// VR-18 line 840) are enforced inline before the network round-trip:
// Status='Completed' requires a trimmed summary ≥10 chars; the other five
// statuses (Attempted / Scheduled / Rescheduled / Canceled / SBOP) accept
// an empty summary. The server VR-18 path also returns a dedicated
// `SUMMARY_REQUIRED_FOR_COMPLETED` envelope which we surface with the
// `(actualLength/minLength)` counter the spec implies.
//
// Participant identity is shown as the resolved display name (the caller threads
// `displayName` from the caseload item / detail body), falling back to the SF
// program-enrollment id only when no name is resolved — mirrors CaseloadRow's
// `displayLabel`. The primary button label embeds the same identity; that label
// IS the EC-28 "tablet single-confirmation tap" — the specialist sees who they're
// about to log against before tapping Submit.
//
// BR-46 (warn on Type='Stability Meeting' override) is out of scope per
// ticket — the spec copy is `[INFERRED — UX to refine]` and the ticket
// explicitly says do not ship guess copy. When the copy lands, the marker
// comment below shows where to wire it.
//
// P3B-04 — dialog chrome lives in `ActionSheetShell`; this component owns
// the form state, validation, and a variant-aware footer (full-width
// stacked CTA on tablet, right-aligned row on laptop).
export function LogCallSheet({
  participantId,
  displayName,
  specialistId,
  idempotencyKey,
  onCancel,
  onSubmit,
}: Props) {
  const participantLabel = displayName ?? participantId;
  const variant = useDeviceVariant();
  // P3C-03 — desktop iframe surface: visibly disable Submit when offline
  // (TR-OFFLINE-2 / BR-67). No-op on tablet PWA (state pinned to "online").
  const connectivity = useConnectivity();
  const writesBlocked = connectivity === "degraded";
  // P3C-02 — hydrate from the per-specialist draft store on mount; the read
  // is done via `getState()` so the initial render uses persisted values
  // without subscribing to subsequent store updates (the sheet is the sole
  // writer for its own draft slot; subscribing would re-render on every
  // local keystroke that we just wrote). Transparent hydration per the
  // ticket UX decision — no "Draft restored" banner.
  const draftScopeKey = makeDraftScopeKey(specialistId, participantId);
  const setLogCallDraft = useDraftStore((s) => s.setLogCallDraft);
  const [status, setStatus] = useState<LogCallStatus>(
    () =>
      useDraftStore.getState().logCall[draftScopeKey]?.status ??
      LOG_CALL_DEFAULT_STATUS,
  );
  const [type, setType] = useState<LogCallType>(
    () =>
      useDraftStore.getState().logCall[draftScopeKey]?.type ??
      LOG_CALL_DEFAULT_TYPE,
  );
  const [serviceDate, setServiceDate] = useState<string>(
    () =>
      useDraftStore.getState().logCall[draftScopeKey]?.serviceDate ??
      formatLocalYyyyMmDd(new Date()),
  );
  const [summary, setSummary] = useState<string>(
    () => useDraftStore.getState().logCall[draftScopeKey]?.summary ?? "",
  );
  const [submitting, setSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [bannerError, setBannerError] = useState<MutationFailure | null>(null);

  // P3C-02 — mirror the live form into the draft store on every change. The
  // store's persist middleware writes through to idb-keyval (or the in-
  // memory adapter on the iframe surface — see `store.ts`). idb-keyval
  // serializes concurrent writes internally so a fast typist doesn't race
  // the disk. Cleared by the parent on successful submit
  // (`CaseloadView.handleLogCallSubmit`); intentionally NOT cleared on
  // Cancel — Cancel is a dismiss, not a discard (AC #2: survives navigation
  // and close→reopen).
  useEffect(() => {
    setLogCallDraft(specialistId, participantId, {
      status,
      type,
      serviceDate,
      summary,
    });
  }, [
    setLogCallDraft,
    specialistId,
    participantId,
    status,
    type,
    serviceDate,
    summary,
  ]);

  const titleId = useId();
  const statusFieldId = useId();
  const typeFieldId = useId();
  const dateFieldId = useId();
  const summaryFieldId = useId();
  const statusErrorId = useId();
  const typeErrorId = useId();
  const dateErrorId = useId();
  const summaryErrorId = useId();
  const summaryHintId = useId();

  const firstControlRef = useRef<HTMLSelectElement | null>(null);
  // F-19 voice affordance: the mic button focuses this textarea so the
  // specialist is one tap from the device keyboard's dictation key. It does
  // NOT capture audio — per TR-VOICE-DICTATION-2 the tool builds no recorder;
  // the OS keyboard does speech→text and we only ever read the resulting text.
  const summaryRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    firstControlRef.current?.focus();
  }, []);

  const summaryTrimLen = summary.trim().length;
  const summaryRequired = status === "Completed";
  // The window check (≥ today-14d, ≤ today per FS VR-17) runs both here and
  // in the native date picker's `min`/`max` attrs so a paste of an
  // out-of-window value still trips a guard.
  const dateBounds = computeServiceDateBounds(new Date());

  async function handleSubmit(ev: React.FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    // P1F-06 — tap-to-submit perf mark. Records the submit-button-click
    // instant (BEFORE client-side validation), so the per-stage breakdown
    // separates sheet-fill time (sheet:open → submit:start) from everything
    // downstream (validation + optimistic dispatch + network round-trip).
    // A future async validator's cost would surface in `submit_to_optimistic`.
    performance.mark?.("logcall:submit:start");
    setBannerError(null);

    const errors = validate({
      status,
      type,
      serviceDate,
      summary,
      dateBounds,
    });
    if (hasAnyError(errors)) {
      setFieldErrors(errors);
      return;
    }
    setFieldErrors({});

    setSubmitting(true);
    const input: LogCallInput = {
      status,
      type,
      serviceDate,
      ...(summaryTrimLen > 0 ? { summary } : {}),
    };
    const failure = await onSubmit(input, idempotencyKey);
    setSubmitting(false);

    if (failure !== null) {
      const mapped = mapFailureToFields(failure);
      if (mapped.fieldErrors !== null) {
        setFieldErrors(mapped.fieldErrors);
      }
      if (mapped.bannerError !== null) {
        setBannerError(mapped.bannerError);
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
        Log Call
      </h2>
      <p className="mt-1 text-xs text-muted-foreground">
        Participant {participantLabel}
      </p>
      <form onSubmit={handleSubmit} className="mt-4 space-y-4">
        <Field
          id={statusFieldId}
          label="Status"
          errorId={statusErrorId}
          error={fieldErrors.status}
        >
          <select
            ref={firstControlRef}
            id={statusFieldId}
            value={status}
            onChange={(e) => setStatus(e.target.value as LogCallStatus)}
            aria-describedby={
              fieldErrors.status === undefined ? undefined : statusErrorId
            }
            aria-invalid={fieldErrors.status !== undefined}
            disabled={submitting}
            className={selectClass}
          >
            {LOG_CALL_STATUS_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </Field>

        {/* BR-46 deferred: when copy lands, render the
            `Type='Stability Meeting'` warning here (between Type field and
            its error). Spec copy is `[INFERRED — UX to refine]` per
            FS v1.12 line 835; ticket explicitly forbids shipping guess
            copy. */}
        <Field
          id={typeFieldId}
          label="Type"
          errorId={typeErrorId}
          error={fieldErrors.type}
        >
          <select
            id={typeFieldId}
            value={type}
            onChange={(e) => setType(e.target.value as LogCallType)}
            aria-describedby={
              fieldErrors.type === undefined ? undefined : typeErrorId
            }
            aria-invalid={fieldErrors.type !== undefined}
            disabled={submitting}
            className={selectClass}
          >
            {LOG_CALL_TYPE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </Field>

        <Field
          id={dateFieldId}
          label="Service Date"
          errorId={dateErrorId}
          error={fieldErrors.serviceDate}
        >
          <input
            id={dateFieldId}
            type="date"
            value={serviceDate}
            onChange={(e) => setServiceDate(e.target.value)}
            min={dateBounds.min}
            max={dateBounds.max}
            aria-describedby={
              fieldErrors.serviceDate === undefined ? undefined : dateErrorId
            }
            aria-invalid={fieldErrors.serviceDate !== undefined}
            disabled={submitting}
            className={selectClass}
          />
        </Field>

        <div className="space-y-1">
          <div className="flex items-baseline justify-between">
            <label htmlFor={summaryFieldId} className="text-sm font-medium">
              Summary{" "}
              {summaryRequired ? (
                <span className="text-destructive">*</span>
              ) : (
                <span className="text-muted-foreground">(optional)</span>
              )}
            </label>
            <span
              id={summaryHintId}
              className="text-xs tabular-nums text-muted-foreground"
            >
              {summaryRequired
                ? `${summaryTrimLen}/${SUMMARY_MIN_LEN_COMPLETED} min · ${summary.length}/${SUMMARY_MAX_LEN}`
                : `${summary.length}/${SUMMARY_MAX_LEN}`}
            </span>
          </div>
          {isTablet && (
            <div className="flex flex-col items-center gap-1 py-2">
              <button
                type="button"
                onClick={() => summaryRef.current?.focus()}
                disabled={submitting}
                aria-label="Dictate your note with the keyboard microphone"
                className="inline-flex h-14 w-14 items-center justify-center rounded-full border-2 border-primary text-primary transition active:scale-95 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <MicGlyph />
              </button>
              <p className="text-xs text-muted-foreground">
                Tap, then use your keyboard mic to speak
              </p>
            </div>
          )}
          <textarea
            id={summaryFieldId}
            ref={summaryRef}
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            disabled={submitting}
            rows={4}
            maxLength={SUMMARY_MAX_LEN}
            inputMode="text"
            autoCapitalize="sentences"
            aria-describedby={
              fieldErrors.summary === undefined
                ? summaryHintId
                : `${summaryHintId} ${summaryErrorId}`
            }
            aria-invalid={fieldErrors.summary !== undefined}
            className="block w-full rounded-md border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          {isTablet && (
            <p className="text-xs text-muted-foreground">
              🔒 We never record audio — your device types the words.
            </p>
          )}
          {fieldErrors.summary !== undefined && (
            <p
              id={summaryErrorId}
              role="alert"
              className="text-sm text-destructive"
            >
              {fieldErrors.summary}
            </p>
          )}
        </div>

        {bannerError !== null && (
          <div
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            <p>
              {bannerError.message} [{bannerError.code}]
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
            type="submit"
            disabled={submitting || writesBlocked}
            title={writesBlocked ? "Offline — Write Access Suspended" : undefined}
            className={primaryClass}
          >
            {submitting ? "Saving…" : `Log call for ${participantLabel}`}
          </Button>
        </div>
      </form>
    </ActionSheetShell>
  );
}

const selectClass =
  "block h-11 w-full rounded-md border bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

interface FieldProps {
  readonly id: string;
  readonly label: string;
  readonly errorId: string;
  readonly error: string | undefined;
  readonly children: React.ReactNode;
}

function Field({ id, label, errorId, error, children }: FieldProps) {
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      {children}
      {error !== undefined && (
        <p id={errorId} role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

// Decorative mic glyph for the dictation affordance (the button's accessible
// name lives on the <button> via aria-label).
function MicGlyph() {
  return (
    <svg
      aria-hidden="true"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
      <path d="M19 10v1a7 7 0 0 1-14 0v-1" />
      <line x1="12" y1="19" x2="12" y2="22" />
      <line x1="8" y1="22" x2="16" y2="22" />
    </svg>
  );
}
