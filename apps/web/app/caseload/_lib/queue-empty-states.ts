// Per-queue empty-state copy for the Caseload SPA (VR-09, F-04).
//
// VR-09 (FS v1.12) requires an empty queue to render an explanatory empty-state
// — not an error. The four ids match BR-22's configured queues and the `queue`
// enum on E-06 (API v1.3 §7.3.1). Copy is queue-appropriate (friendlier for
// queues where empty is a positive outcome, neutral for `caseload_overview`).
//
// Strings live here (mirroring `queue-labels.ts`) rather than in M-CONFIG so
// demo-day tuning is a one-file edit. Unknown ids fall through to a generic
// fallback so a server-driven BR-22 queue addition does not crash the UI.

const KNOWN_QUEUE_EMPTY_STATES: Readonly<Record<string, string>> = {
  caseload_overview: "No participants in your caseload yet.",
  due_soon: "No check-ins coming due in the next few days.",
  never_successfully_contacted:
    "Everyone in your caseload has been reached at least once.",
  check_ins_due_this_month: "All caught up for this month.",
};

const FALLBACK_EMPTY_STATE = "No participants in this queue.";

export function queueEmptyState(queueId: string): string {
  return KNOWN_QUEUE_EMPTY_STATES[queueId] ?? FALLBACK_EMPTY_STATE;
}
