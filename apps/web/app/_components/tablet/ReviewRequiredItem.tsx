"use client";

import type { QueuePendingItem, QueueResolveRequest } from "@anthos/api";

// Derived locally — `ResolutionAction` is not re-exported from `@anthos/api`,
// and importing it from `@anthos/persistence` would risk dragging server-only
// deps into the client bundle. The resolve action union is the source of truth.
type ResolutionAction = QueueResolveRequest["action"];

// P3C-13 — Review Required queue item, now wired to the real server-side
// `offline_queue` (E-17/E-19). Renders the Pattern E race-condition narrative
// (the specialist was offline; Salesforce rejected or rerouted the write) with
// the resolution affordances the server offers.
//
// REASSIGN_RETRY is GATED this ticket: `POST /queue/:id/resolve` requires a
// `newOwnerId`, but `QueuePendingItem` exposes no structured owner id (only a
// free-text `errorDetails.message`). Rather than parse a brittle string, the
// reassign button renders disabled with an explanatory tooltip — DISCARD and
// ESCALATE_TO_SUPERVISOR (which need no extra data) are fully wired. Full
// reassign ships in a follow-up.

interface Props {
  readonly item: QueuePendingItem;
  readonly onResolve: (
    queueItemId: string,
    request: QueueResolveRequest,
  ) => void;
}

function actionLabel(action: ResolutionAction): string {
  switch (action) {
    case "DISCARD":
      return "Discard";
    case "REASSIGN_RETRY":
      return "Reassign & retry";
    case "ESCALATE_TO_SUPERVISOR":
      return "Escalate to supervisor";
  }
}

// REASSIGN_RETRY needs a newOwnerId we can't source yet — see header.
function isGated(action: ResolutionAction): boolean {
  return action === "REASSIGN_RETRY";
}

function requestFor(action: ResolutionAction): QueueResolveRequest | null {
  if (action === "DISCARD") return { action: "DISCARD" };
  if (action === "ESCALATE_TO_SUPERVISOR") {
    return { action: "ESCALATE_TO_SUPERVISOR" };
  }
  // REASSIGN_RETRY is gated (no newOwnerId source).
  return null;
}

export function ReviewRequiredItem({ item, onResolve }: Props) {
  const meta =
    item.errorDetails?.message ??
    "This action needs your review before it can sync.";

  return (
    <div
      className="rounded-md border-l-[3px] border-tabletReview bg-tabletReviewBg p-3"
      data-testid="review-required-item"
      data-queue-item-id={item.queueItemId}
    >
      <p className="mb-0.5 text-xs font-semibold text-[#5b21b6]">
        Review required
        {item.participantId !== null ? ` · ${item.participantId}` : ""}
      </p>
      <p className="text-[11px] leading-snug text-[#6d28d9]">{meta}</p>
      <div className="mt-2 flex gap-1.5">
        {item.resolutionOptions.map((action) => {
          const gated = isGated(action);
          const suggested = item.suggestedResolution === action;
          return (
            <button
              key={action}
              type="button"
              disabled={gated}
              title={
                gated
                  ? "Reassignment target selection ships in a follow-up"
                  : undefined
              }
              onClick={() => {
                const request = requestFor(action);
                if (request !== null) onResolve(item.queueItemId, request);
              }}
              data-action={action}
              data-suggested={suggested ? "true" : "false"}
              className={`flex-1 rounded border px-2 py-2 text-[11px] font-semibold ${
                gated
                  ? "cursor-not-allowed border-[#e9d5ff] bg-[#faf5ff] text-[#a78bca]"
                  : suggested
                    ? "border-[#7c3aed] bg-[#ede9fe] text-[#5b21b6]"
                    : "border-[#ddd6fe] bg-white text-[#5b21b6] hover:bg-[#ede9fe]"
              }`}
            >
              {actionLabel(action)}
            </button>
          );
        })}
      </div>
    </div>
  );
}
