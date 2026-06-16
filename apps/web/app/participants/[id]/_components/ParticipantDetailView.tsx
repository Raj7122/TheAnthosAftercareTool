import { ArrowLeft } from "lucide-react";

import type { ParticipantDetailBody } from "@anthos/api";

import { BackToCaseloadLink } from "./BackToCaseloadLink";
import { ParticipantCommsProvider } from "../../../_components/comms/ParticipantCommsProvider";
import { RecentContactsTimelineLive } from "../../../_components/comms/RecentContactsTimelineLive";
import type { CommsChannel } from "../../../_lib/comms/types";
// ⚠️ DEMO ONLY — remove after the 2026-06-15 demo.
import { getDemoOverride } from "../_lib/demo-overrides";
import { BarriersPanel } from "./BarriersPanel";
import { ContactPreferencesCard } from "./ContactPreferencesCard";
import { CycleBreakdownPanel } from "./CycleBreakdownPanel";
import { DemographicsContextCard } from "./DemographicsContextCard";
import { ParticipantHeader } from "./ParticipantHeader";
import { QuickActionsBar } from "./QuickActionsBar";
import { RepairsPanel } from "./RepairsPanel";
import { CaseNotesPanel } from "./CaseNotesPanel";
import { SupervisorReadOnlyBanner } from "./SupervisorReadOnlyBanner";
import { VoucherSubsidyCard } from "./VoucherSubsidyCard";

export type SessionRole = "SPECIALIST" | "SUPERVISOR" | "VP" | "SYSTEM_ADMIN";

interface Props {
  readonly body: ParticipantDetailBody;
  readonly role: SessionRole;
  readonly barrierTypes: ReadonlyArray<string>;
  readonly salesforceInstanceUrl: string | null;
  // P3C-02 — threaded from `/me` for per-specialist draft scoping on the
  // F-06 create-Barrier sheet rendered inside BarriersPanel.
  readonly specialistId: string;
  // P1H-11 (demo) — caseload → detail deep-link pre-opens a compose sheet.
  readonly initialCompose: CommsChannel | null;
}

// F-07 detail-view composition — 2026-05-25 wireframe layout.
//
// Top stack (full width): header (identity + tier pill + since-contact/cycle
// stats + factor-breakdown drawer) → quick-actions bar. AC-28 above-the-fold
// story still satisfied — "Log call" is the leftmost button in the bar, which
// sits directly under the header. F-13 single-primary-action constraint
// preserved.
//
// Below the top stack: 3-col grid. Left column (`lg:col-span-2`) holds the
// stability-cycle timeline + recent contacts. Right column (`lg:col-span-1`)
// holds Open Barriers + the three context cards (Voucher, Demographics,
// Contact Preferences). On mobile (`< lg`) the grid collapses to a single
// column — the cards stack in the same order, so primary content stays on
// top.
//
// `role === "SUPERVISOR"` adds the AC-29 banner. `canMutate` mirrors the
// caseload precedent (`role !== "system_admin" && role !== "SUPERVISOR"`):
// supervisors get read-only Barriers, system_admins are 403'd upstream.
export function ParticipantDetailView({
  body,
  role,
  barrierTypes,
  salesforceInstanceUrl,
  specialistId,
  initialCompose,
}: Props) {
  const showSupervisorBanner = role === "SUPERVISOR";
  const canMutateBarriers = role !== "SUPERVISOR" && role !== "SYSTEM_ADMIN";
  // ⚠️ DEMO ONLY — frontend dummy data for the demo participant (Doris
  // Simmons). `undefined` for everyone else, so their cards keep the real
  // stub state. Remove after the 2026-06-15 demo.
  const demo = getDemoOverride(body.participantId);
  return (
    // P1H-11 (demo) — the comms provider wraps the whole view so the
    // quick-action launchers (in the bar) and the optimistic timeline (left
    // column) share one client-only state.
    <ParticipantCommsProvider
      participantId={body.participantId}
      specialistId={specialistId}
      displayName={body.displayName}
      phone={body.contact.phone}
      email={body.contact.email}
      initialCompose={initialCompose}
    >
      <div className="space-y-4">
        {/* Top-left back affordance — the detail view is reached by clicking a
            caseload row, so the specialist needs an explicit way back. Mirrors
            the "Back to caseload" link the error-state panels already use. */}
        <BackToCaseloadLink
          variant="ghost"
          size="sm"
          className="-ml-2 self-start text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="mr-1 h-4 w-4" aria-hidden="true" />
          Back to caseload
        </BackToCaseloadLink>
        {showSupervisorBanner && <SupervisorReadOnlyBanner />}
        <ParticipantHeader
          identity={body}
          salesforceInstanceUrl={salesforceInstanceUrl}
        />
        <QuickActionsBar quickActions={body.quickActions} />
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <div className="space-y-4 lg:col-span-2">
            <CycleBreakdownPanel
              breakdown={body.perCheckpointBreakdown}
              aftercareStartDate={body.aftercareStartDate}
              cycleStatus={body.cycleStatus}
            />
            <RecentContactsTimelineLive
              recentContacts={body.recentContacts}
              openBarriers={body.openBarriers}
              stabilityVisit={body.stabilityVisit}
            />
          </div>
          <div className="space-y-4 lg:col-span-1">
            <BarriersPanel
              initialBody={body}
              barrierTypes={barrierTypes}
              canMutate={canMutateBarriers}
              specialistId={specialistId}
            />
            <RepairsPanel
              participantId={body.participantId}
              displayName={body.displayName}
              canMutate={canMutateBarriers}
            />
            <CaseNotesPanel
              participantId={body.participantId}
              displayName={body.displayName}
              canMutate={canMutateBarriers}
            />
            {/* ⚠️ DEMO ONLY — `demo?.…` supplies dummy props for the demo
                participant; falls back to the real body for everyone else.
                Remove after the 2026-06-15 demo. */}
            <VoucherSubsidyCard voucher={demo?.voucher} />
            <DemographicsContextCard demographics={demo?.demographics} />
            <ContactPreferencesCard
              contact={
                demo ? { ...body.contact, address: demo.address } : body.contact
              }
              communicationConsent={
                demo?.communicationConsent ?? body.communicationConsent
              }
              preferredContactMethod={
                demo?.preferredContactMethod ?? body.preferredContactMethod
              }
            />
          </div>
        </div>
      </div>
    </ParticipantCommsProvider>
  );
}
