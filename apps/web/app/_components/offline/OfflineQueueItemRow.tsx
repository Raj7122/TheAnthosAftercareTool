"use client";

// P3C-12 — single Review Required item with inline resolve form.
//
// Renders the action type, created-at timestamp, the server-redacted
// `payloadPreview.snippet` (allow-listed by P3C-05's dto.ts so we never
// echo full PHI), and the Salesforce error context. The form exposes the
// three Pattern E actions; `REASSIGN_RETRY` reveals the new-owner field
// (Demo-Mode: free text for the SF user id — the BFF's `assertSalesforceId`
// is the source of truth; a proper owner picker is a follow-up).
//
// All field validation lives server-side: empty `newOwnerId` for
// REASSIGN_RETRY returns 400 with a `details.field` envelope, which we
// surface inline via `failure.message`.

import { useState, type FormEvent } from "react";

import type { QueuePendingItem, QueueResolveRequest } from "@anthos/api";

import type { ResolveOutcome } from "../../_lib/offline/queue-pending-client";
import {
  RESOLVE_ACTIONS,
  RESOLVE_ACTION_LABELS,
  type ResolveAction,
} from "../../_lib/offline/resolve-actions";

interface Props {
  readonly item: QueuePendingItem;
  readonly submitting: boolean;
  readonly disabled: boolean;
  readonly onResolve: (request: QueueResolveRequest) => Promise<ResolveOutcome>;
}

export function OfflineQueueItemRow({
  item,
  submitting,
  disabled,
  onResolve,
}: Props) {
  const initialAction: ResolveAction =
    (item.suggestedResolution as ResolveAction | null) ?? RESOLVE_ACTIONS[0];
  const [action, setAction] = useState<ResolveAction>(initialAction);
  const [newOwnerId, setNewOwnerId] = useState("");
  const [notes, setNotes] = useState("");
  const [failure, setFailure] = useState<{
    readonly message: string;
    readonly field: string | null;
  } | null>(null);

  const snippet =
    typeof item.payloadPreview.snippet === "string"
      ? item.payloadPreview.snippet
      : null;
  const rowDisabled = submitting || disabled;

  async function handleSubmit(ev: FormEvent<HTMLFormElement>): Promise<void> {
    ev.preventDefault();
    setFailure(null);
    const request: QueueResolveRequest = {
      action,
      ...(action === "REASSIGN_RETRY"
        ? { newOwnerId: newOwnerId.trim() }
        : {}),
      ...(notes.trim() !== "" ? { notes: notes.trim() } : {}),
    };
    const outcome = await onResolve(request);
    if (outcome.kind === "failure") {
      setFailure({
        message: outcome.failure.message,
        field: outcome.failure.field,
      });
    }
  }

  return (
    <form
      data-testid="offline-queue-item-row"
      data-queue-item-id={item.queueItemId}
      onSubmit={handleSubmit}
      className="rounded-md border border-muted bg-muted/20 p-3"
    >
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span data-testid="offline-queue-item-action-type">
          {item.actionType}
        </span>
        <span>{formatTimestamp(item.createdAt)}</span>
      </div>
      {snippet !== null && (
        <p className="mt-1 text-sm text-foreground">{snippet}</p>
      )}
      {item.errorDetails?.message != null && (
        <p className="mt-1 text-xs text-amber-800">
          {item.errorDetails.sfErrorCode !== null
            ? `${item.errorDetails.sfErrorCode}: `
            : ""}
          {item.errorDetails.message}
        </p>
      )}
      <div className="mt-3 space-y-2">
        <label className="block text-xs font-medium text-foreground">
          Resolution
          <select
            value={action}
            onChange={(ev) => setAction(ev.target.value as ResolveAction)}
            disabled={rowDisabled}
            data-testid="resolve-action-select"
            className="mt-1 block w-full rounded-md border border-input bg-background p-2 text-sm"
          >
            {RESOLVE_ACTIONS.map((opt) => (
              <option key={opt} value={opt}>
                {RESOLVE_ACTION_LABELS[opt]}
              </option>
            ))}
          </select>
        </label>
        {action === "REASSIGN_RETRY" && (
          <label className="block text-xs font-medium text-foreground">
            New owner (Salesforce user id)
            <input
              type="text"
              value={newOwnerId}
              onChange={(ev) => setNewOwnerId(ev.target.value)}
              disabled={rowDisabled}
              data-testid="new-owner-id-input"
              className="mt-1 block w-full rounded-md border border-input bg-background p-2 text-sm"
            />
          </label>
        )}
        <label className="block text-xs font-medium text-foreground">
          Notes (optional)
          <textarea
            value={notes}
            onChange={(ev) => setNotes(ev.target.value)}
            disabled={rowDisabled}
            data-testid="resolve-notes-input"
            maxLength={1000}
            rows={2}
            className="mt-1 block w-full rounded-md border border-input bg-background p-2 text-sm"
          />
        </label>
      </div>
      {failure !== null && (
        <p
          role="alert"
          data-testid="resolve-error"
          className="mt-2 text-xs text-destructive"
        >
          {failure.message}
        </p>
      )}
      <div className="mt-3 flex justify-end">
        <button
          type="submit"
          disabled={rowDisabled}
          data-testid="resolve-submit"
          className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
        >
          {submitting ? "Submitting…" : "Apply"}
        </button>
      </div>
    </form>
  );
}

function formatTimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}
