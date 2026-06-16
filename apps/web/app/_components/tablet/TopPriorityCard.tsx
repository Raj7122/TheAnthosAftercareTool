"use client";

import type { CaseloadItem } from "@anthos/api";

import { firingFactorMessage } from "../participant/firing-factor-message";

// P3C-13 — the F-13 single-primary-action hero, now LIVE. Replaces the
// fixture "Did you just complete this visit?" card (which needed unbuilt P3A
// visit data) with the top-priority participant from real F-02 caseload data
// (`initialCaseloadItems[0]`, already priority-sorted by the BFF). The one
// primary action — "Log notes" — opens the Quick Log sheet (Case Note ·
// IDW_Case_Note__c / Repair · Repair__c). The case note is the first-class
// offline field action; Log Call is desktop-only on the tablet surface.
//
// The "depressible" CTA effect (4px solid shadow collapsing to 2px on :active)
// is preserved from the prior card. Empty caseload renders an "all caught up"
// state rather than a dead card. Read-only sessions (system_admin) keep the
// CTA visible but disabled (BR-67: disabled, not hidden).

interface Props {
  // The single highest-priority row, or null when the caseload is empty /
  // unauthenticated.
  readonly item: CaseloadItem | null;
  // Opens the Quick Log sheet for this participant (parent mints the Pattern D
  // key and mounts the sheet).
  readonly onLogNotes: (participantId: string) => void;
  // P3C — role gate mirroring the caseload 📝 action (`role !== "system_admin"`).
  // When false the CTA is disabled rather than hidden, so the hero is never a
  // dead card for read-only supervisors.
  readonly canLogNotes: boolean;
}

export function TopPriorityCard({ item, onLogNotes, canLogNotes }: Props) {
  if (item === null) {
    return (
      <section
        className="m-4 overflow-hidden rounded-xl border-2 border-zinc-200 bg-white p-6 text-center shadow-[0_4px_12px_rgba(29,42,74,0.08)]"
        data-testid="top-priority-card"
        data-empty="true"
      >
        <p className="text-[18px] font-bold text-tabletPrimary">All caught up</p>
        <p className="mt-1 text-[13px] text-zinc-500">No participants need action right now.</p>
      </section>
    );
  }

  const displayName = item.displayName ?? item.participantId;
  const firingReason = firingFactorMessage({
    highestImpactFactor: item.highestImpactFactor,
    factors: item.factors,
    triggeredInvariants: item.triggered_invariants,
  });

  return (
    <section
      className="m-4 overflow-hidden rounded-xl border-2 border-tabletPrimary bg-white shadow-[0_4px_12px_rgba(29,42,74,0.15)]"
      data-testid="top-priority-card"
      data-empty="false"
    >
      <header className="flex items-center gap-2 bg-gradient-to-br from-tabletPrimary to-[#2a3a5e] px-5 py-4 text-[13px] font-semibold uppercase tracking-widest text-white">
        <span>Act today · top priority</span>
      </header>
      <div className="px-5 py-6 text-center">
        <p
          className="my-2 text-[28px] font-extrabold text-tabletPrimary"
          data-testid="top-priority-participant"
        >
          {displayName}
        </p>
        <p className="mb-5 text-[13px] text-zinc-500" data-testid="top-priority-reason">
          {firingReason}
        </p>
        <button
          type="button"
          onClick={() => onLogNotes(item.participantId)}
          disabled={!canLogNotes}
          title={canLogNotes ? undefined : "Read-only — case notes are disabled"}
          data-testid="top-priority-cta"
          className="w-full rounded-xl bg-tabletPrimary px-8 py-[18px] text-[17px] font-bold text-white shadow-[0_4px_0_#0f1729] transition-transform active:translate-y-0.5 active:shadow-[0_2px_0_#0f1729] disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-[0_4px_0_#0f1729] disabled:active:translate-y-0"
        >
          Log notes
        </button>
      </div>
    </section>
  );
}
