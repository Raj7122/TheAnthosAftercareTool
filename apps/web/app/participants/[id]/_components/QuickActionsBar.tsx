"use client";

import type { QuickActionDisabledReason, QuickActions } from "@anthos/api";

import { Button } from "@/components/ui/button";

import { useConnectivity } from "../../../_lib/connectivity/context";
import { useParticipantComms } from "../../../_components/comms/ParticipantCommsProvider";
import type { CommsChannel } from "../../../_lib/comms/types";
import { quickActionDisabledCopy } from "../_lib/quick-action-copy";

const WRITES_BLOCKED_TOOLTIP = "Offline — Write Access Suspended";

interface Props {
  readonly quickActions: QuickActions;
}

// P1H-11 (demo) — the SMS / email / schedule launchers open client-only
// compose sheets. The server's per-action `quickActions` state still gates the
// genuine read-only roles (supervisor / system_admin → `supervisor_read_only`),
// but the consent / phone / email stubs that keep these disabled today
// (P1F-01) are overridden so the demo workflow is reachable. The real F-09 /
// F-12 / email endpoints reinstate the authoritative gating server-side.
const COMMS_CHANNEL: Partial<Record<ActionId, CommsChannel>> = {
  logCall: "call",
  sendSms: "sms",
  sendEmail: "email",
  scheduleVisit: "schedule",
};

// F-07 quick-actions bar. BR-39 / AC-28: four buttons in a fixed order above
// the fold. The buttons render as inert in P1F-08 (action sheets ship in
// P1F-04 and later); the `onClick`-less buttons keep keyboard focus and
// tooltip behavior so the affordance still reads as "this is here, soon".
//
// AC-29: when role === SUPERVISOR the server returns `supervisor_read_only`
// on every action; the `SupervisorReadOnlyBanner` carries the single banner,
// and each button still surfaces a hover tooltip for screen-reader parity.
//
// Tablet F-13: h-11 tap targets, single-row flex with wrap as a safety net
// (10" portrait keeps all four on one line).
type ActionId = "logCall" | "sendSms" | "sendEmail" | "scheduleVisit";

const ACTIONS: ReadonlyArray<{
  readonly id: ActionId;
  readonly label: string;
}> = [
  { id: "logCall", label: "Log call" },
  { id: "sendSms", label: "Send SMS" },
  { id: "sendEmail", label: "Send email" },
  { id: "scheduleVisit", label: "Schedule visit" },
];

// "Log a visit" is a tablet-PWA-only affordance (F-13) and is intentionally
// absent from this desktop iframe surface — the tablet build owns it. Do not
// re-add a disabled placeholder here; it added noise without a desktop path.

export function QuickActionsBar({ quickActions }: Props) {
  // P3C-03 — desktop iframe surface: visibly disable every write button when
  // the BFF heartbeat or `navigator.onLine` reports degraded connectivity
  // (TR-OFFLINE-2 / BR-67 "visibly disabled, NOT hidden"). On the tablet
  // PWA surface the provider keeps state pinned at "online", so this OR
  // collapses to its existing per-action logic — no cross-surface leak.
  const connectivity = useConnectivity();
  const writesBlocked = connectivity === "degraded";
  const { openCompose } = useParticipantComms();
  return (
    <nav
      aria-label="Quick actions"
      className="flex flex-wrap gap-2 rounded-lg border bg-card p-3 shadow-sm"
    >
      {ACTIONS.map(({ id, label }) => {
        const state = quickActions[id];
        const reason = quickActions[reasonKey(id)];
        const channel = COMMS_CHANNEL[id];
        // Genuine read-only roles stay disabled; for comms launchers the demo
        // ignores the consent/phone/email stubs (see COMMS_CHANNEL note).
        const readOnly = reason === "supervisor_read_only";
        const enabled =
          channel !== undefined ? !readOnly : state === "enabled";
        const tooltip = writesBlocked
          ? WRITES_BLOCKED_TOOLTIP
          : readOnly
            ? quickActionDisabledCopy(reason)
            : channel !== undefined
              ? undefined
              : quickActionDisabledCopy(reason);
        return (
          <Button
            key={id}
            type="button"
            variant={enabled && !writesBlocked ? "default" : "outline"}
            className="h-11 min-w-[7.5rem] flex-1 sm:flex-initial"
            disabled={!enabled || writesBlocked}
            title={tooltip}
            aria-label={tooltip === undefined ? label : `${label} — ${tooltip}`}
            data-action-id={id}
            onClick={
              channel !== undefined && enabled && !writesBlocked
                ? () => openCompose(channel)
                : undefined
            }
          >
            {label}
          </Button>
        );
      })}
    </nav>
  );
}

function reasonKey(
  id: ActionId,
):
  | "logCallDisabledReason"
  | "sendSmsDisabledReason"
  | "sendEmailDisabledReason"
  | "scheduleVisitDisabledReason" {
  return `${id}DisabledReason` as const;
}

// Re-export so consumers don't need to dual-import from @anthos/api when they
// only render the bar.
export type { QuickActionDisabledReason };
