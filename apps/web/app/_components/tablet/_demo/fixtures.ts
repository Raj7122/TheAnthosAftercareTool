// Demo-only stub data for the tablet field-card landing. Every constant in
// this file is hardcoded narrative for a stakeholder walkthrough on Chrome
// DevTools iPad emulation. The `_demo/` directory is the deletion seam: when
// the real P3A integrations ship, `grep -r _demo apps/web` lists everything
// to remove and the import sites get repointed at real hooks.
//
// Stub data; see the demo→production translation table for the mapping.

// P3C-13 — the hero (DEMO_JUST_COMPLETED_VISIT) and Pending Sync queue
// (DEMO_PENDING_QUEUE) fixtures were retired when those surfaces went live:
// the hero now renders the top-priority `CaseloadItem`, the syncing rows come
// from the client Outbox (`useOutbox`), and Review-Required rows come from the
// server `offline_queue` (`useQueuePending`). Only the caseload mini-list
// fallback remains — it keeps the page from going visually blank when the real
// F-02 fetch returns zero rows during a stakeholder walkthrough.

export interface DemoCaseloadFallbackRow {
  readonly participantId: string;
  readonly displayName: string;
  readonly firingReason: string;
}

// Used only when the real F-02 caseload fetch returns zero rows — keeps the
// demo from going visually blank. CollapsedCaseload prefers real data when
// `initialCaseloadItems.length > 0`.
export const DEMO_TODAYS_CASELOAD_FALLBACK: ReadonlyArray<DemoCaseloadFallbackRow> = [
  {
    participantId: "demo-participant-mileena",
    displayName: "Mileena Lesane",
    firingReason: "Stability visit overdue 7d",
  },
  {
    participantId: "demo-participant-gcinokuhle",
    displayName: "Gcinokuhle Mkhwanazi",
    firingReason: "Voucher recert 9d · 2 missed checkpoints",
  },
  {
    participantId: "demo-participant-claribel",
    displayName: "Claribel Pena",
    firingReason: "Stability visit due in 18d · open arrears",
  },
];

// Mockup shows "Today's caseload (3 of 62 shown)" — the 62 is decorative
// when the real fetch returns < 62 rows. CollapsedCaseload uses the real
// `caseloadCount` from props when > 0 and falls back to this otherwise.
export const DEMO_CASELOAD_TOTAL_FALLBACK = 62;
