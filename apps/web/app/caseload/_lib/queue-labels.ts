// Queue id → display label mapping for the queue selector (BR-23).
//
// The four ids match BR-22's configured queues (FS v1.12 §F-04) and the
// `queue` enum on E-06 (API v1.3 §7.3.1). Labels are demo-presentation copy
// kept here as a closed map — the SPA never invents a label for an unknown
// id; unknown ids fall through to the id itself so a server-driven queue
// addition (BR-22 config) won't crash the UI.

// Q-DEMO-1 demo-presentation choice (not a spec change): land on the
// "today's action queue" rather than BR-20's spec default `caseload_overview`.
export const DEFAULT_LANDING_QUEUE_ID = "due_soon";

const KNOWN_QUEUE_LABELS: Readonly<Record<string, string>> = {
  caseload_overview: "Caseload overview",
  due_soon: "Due soon",
  never_successfully_contacted: "Never contacted",
  check_ins_due_this_month: "Check-ins due this month",
};

// Canonical render order for the BR-23 queue selector. The cache-warm
// path returns `queueCounts` with JSONB-normalized key order, while the
// cache-cold path returns insertion order from
// `Object.entries(configuration.queuePredicates)` — the two diverge.
// Render order MUST come from this list, not from `Object.keys(queueCounts)`,
// so the selector is identical across cache states (AC-12).
export const KNOWN_QUEUE_IDS: ReadonlyArray<string> = Object.keys(
  KNOWN_QUEUE_LABELS,
);

export function queueLabel(queueId: string): string {
  return KNOWN_QUEUE_LABELS[queueId] ?? queueId;
}

// Plain-language description of what each queue contains, for the queue-tab
// hover tooltip. Same closed-map discipline as the labels: an unknown id
// (BR-22 server-driven addition) returns null and the tab simply renders
// without a tooltip rather than inventing copy.
const KNOWN_QUEUE_DESCRIPTIONS: Readonly<Record<string, string>> = {
  caseload_overview: "Everyone on your caseload, ranked by priority.",
  due_soon: "Participants with a stability checkpoint due in the next few days.",
  never_successfully_contacted:
    "Participants you've never reached with a successful contact.",
  check_ins_due_this_month:
    "Participants whose monthly check-in falls in the current month.",
};

export function queueDescription(queueId: string): string | null {
  return KNOWN_QUEUE_DESCRIPTIONS[queueId] ?? null;
}

// Stable render order for the queue selector. Known ids first, in
// canonical order; unknown ids (BR-22 server-driven additions) appended
// in their `queueCounts` insertion order so the UI doesn't crash when
// the config grows ahead of this client.
export function orderQueueIds(
  queueCounts: Readonly<Record<string, number>>,
): ReadonlyArray<string> {
  const ordered: string[] = [];
  for (const id of KNOWN_QUEUE_IDS) {
    if (id in queueCounts) ordered.push(id);
  }
  for (const id of Object.keys(queueCounts)) {
    if (!(id in KNOWN_QUEUE_LABELS)) ordered.push(id);
  }
  return ordered;
}
