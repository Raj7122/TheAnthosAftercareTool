"use client";

import { memo, type MouseEvent } from "react";
import Link from "next/link";

import { useConnectivity } from "../../_lib/connectivity/context";
import type { CommsChannel } from "../../_lib/comms/types";

export type QuickActionsVariant = "desktop" | "tablet";

const WRITES_BLOCKED_TOOLTIP = "Offline — Write Access Suspended";

interface Props {
  readonly participantId: string;
  readonly canLogCalls: boolean;
  // Gates the "+" quick action, which logs a Repair (NOT a barrier). Barriers
  // are added from the participant profile only.
  readonly canMutateRepairs: boolean;
  // Gates the 📝 quick action, which logs a general Case Note (IDW_Case_Note__c).
  readonly canLogCaseNotes: boolean;
  readonly onLogCall: (participantId: string) => void;
  readonly onAddRepair: (participantId: string) => void;
  readonly onLogCaseNote: (participantId: string) => void;
  // P3B-03 — tablet variant trades the dense desktop sizing (h-8 / 32px,
  // gap-1) for finger-friendly h-11 / 44px buttons with gap-2, satisfying
  // the F-13 AC-48 touch-target floor that P3B-02 established for the
  // tablet landing's secondary row. Default keeps every existing
  // CaseloadRow call site identical.
  readonly variant?: QuickActionsVariant;
  // Merged into the action cluster's container class. Caseload rows pass
  // `relative z-10` so the buttons paint above the row's stretched-link
  // navigation overlay and stay independently clickable. Defaults to no
  // extra classes, keeping every other call site identical.
  readonly className?: string;
}

// P1H-05 QUICK ACTIONS cell — inline icon buttons. P1H-11 (demo) flips the
// SMS / Email / Schedule icons from disabled placeholders to enabled launchers
// that deep-link to the participant detail page with `?compose=` so the
// compose sheet opens on arrival. Every button stops propagation so a click on
// a quick action never also toggles the row-level navigation owned by
// `CaseloadRow`.

function QuickActionsRowImpl({
  participantId,
  canLogCalls,
  canMutateRepairs,
  canLogCaseNotes,
  onLogCall,
  onAddRepair,
  onLogCaseNote,
  variant = "desktop",
  className,
}: Props) {
  // P3C-03 — desktop iframe surface: visibly disable Log Call + Add Repair
  // when connectivity is degraded (TR-OFFLINE-2 / BR-67). State stays
  // "online" on the tablet PWA surface, so this OR collapses to the
  // existing per-button logic there.
  const connectivity = useConnectivity();
  const writesBlocked = connectivity === "degraded";
  const stop = (e: MouseEvent) => e.stopPropagation();
  const containerClass =
    variant === "tablet"
      ? "inline-flex items-center justify-end gap-2 rounded-xl bg-zinc-50/70 p-1"
      : "inline-flex items-center justify-end gap-1 rounded-xl bg-zinc-50/70 p-1";
  return (
    <div className={className ? `${containerClass} ${className}` : containerClass}>
      {canLogCalls && (
        <QuickActionButton
          title={writesBlocked ? WRITES_BLOCKED_TOOLTIP : "Log Call"}
          variant={variant}
          disabled={writesBlocked}
          onClick={(e) => {
            stop(e);
            onLogCall(participantId);
          }}
        >
          📞
        </QuickActionButton>
      )}
      {canMutateRepairs && (
        <QuickActionButton
          title={writesBlocked ? WRITES_BLOCKED_TOOLTIP : "Add repair"}
          variant={variant}
          disabled={writesBlocked}
          onClick={(e) => {
            stop(e);
            onAddRepair(participantId);
          }}
        >
          ➕
        </QuickActionButton>
      )}
      {canLogCaseNotes && (
        <QuickActionButton
          title={writesBlocked ? WRITES_BLOCKED_TOOLTIP : "Log case note"}
          variant={variant}
          disabled={writesBlocked}
          onClick={(e) => {
            stop(e);
            onLogCaseNote(participantId);
          }}
        >
          📝
        </QuickActionButton>
      )}
      <QuickActionLink
        title="Send SMS"
        participantId={participantId}
        channel="sms"
        variant={variant}
        writesBlocked={writesBlocked}
        stop={stop}
      >
        💬
      </QuickActionLink>
      <QuickActionLink
        title="Send email"
        participantId={participantId}
        channel="email"
        variant={variant}
        writesBlocked={writesBlocked}
        stop={stop}
      >
        ✉️
      </QuickActionLink>
      <QuickActionLink
        title="Schedule visit"
        participantId={participantId}
        channel="schedule"
        variant={variant}
        writesBlocked={writesBlocked}
        stop={stop}
      >
        📅
      </QuickActionLink>
    </div>
  );
}

// Shared chrome for the icon affordances — kept identical between the
// <button> (Log Call / Add Repair) and the <Link> (comms) variants so the
// cluster reads as one row.
function quickActionClass(variant: QuickActionsVariant): string {
  const sizingClass =
    variant === "tablet" ? "h-11 w-11 text-base" : "h-8 w-8 text-sm";
  return `relative inline-flex items-center justify-center rounded-lg border-0 bg-transparent text-zinc-600 transition-colors duration-150 hover:bg-white hover:shadow-[0_1px_2px_rgba(0,0,0,0.04)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:shadow-none aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:hover:bg-transparent aria-disabled:hover:shadow-none before:absolute before:inset-[-6px] before:content-[''] ${sizingClass}`;
}

interface QuickActionLinkProps {
  readonly title: string;
  readonly participantId: string;
  readonly channel: CommsChannel;
  readonly variant: QuickActionsVariant;
  readonly writesBlocked: boolean;
  readonly stop: (e: MouseEvent) => void;
  readonly children: React.ReactNode;
}

// P1H-11 (demo) — comms launchers navigate to the detail page with `?compose=`.
// Navigation is a `<Link>` (matching the row's existing Link-based pattern; no
// `useRouter`, which would require a mounted app router and break unit renders
// of CaseloadList). Offline collapses to a disabled, inert button per BR-67.
function QuickActionLink({
  title,
  participantId,
  channel,
  variant,
  writesBlocked,
  stop,
  children,
}: QuickActionLinkProps) {
  if (writesBlocked) {
    return (
      <QuickActionButton
        title={WRITES_BLOCKED_TOOLTIP}
        variant={variant}
        disabled
        onClick={stop}
      >
        {children}
      </QuickActionButton>
    );
  }
  return (
    <Link
      href={`/participants/${participantId}?compose=${channel}`}
      title={title}
      aria-label={title}
      onClick={stop}
      data-variant={variant}
      className={quickActionClass(variant)}
    >
      {children}
    </Link>
  );
}

interface QuickActionButtonProps {
  readonly title: string;
  readonly disabled?: boolean;
  readonly variant: QuickActionsVariant;
  readonly onClick: (e: MouseEvent<HTMLButtonElement>) => void;
  readonly children: React.ReactNode;
}

function QuickActionButton({
  title,
  disabled = false,
  variant,
  onClick,
  children,
}: QuickActionButtonProps) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      data-variant={variant}
      className={quickActionClass(variant)}
    >
      {children}
    </button>
  );
}

export const QuickActionsRow = memo(QuickActionsRowImpl);
