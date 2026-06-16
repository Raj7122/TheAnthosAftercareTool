"use client";

// Pattern A optimistic-UI hook for F-06 Barrier create/close. Owns the
// caseload-row client state; sheets call `createBarrier` / `closeBarrier`
// and receive a structured outcome they render inline (no toasts — VR-12 /
// VR-13 / VR-14 surface on the field that drove them).
//
// One `Idempotency-Key` per user action (TR-OFFLINE-6a + Immutable #6) —
// generated at submission, not at network send, so a transparent middleware
// retry against the BFF lands on the same idempotency row. Offline-queue
// fan-out is intentionally out of scope here: a Network/5xx-exhausted error
// surfaces to the sheet as a terminal failure (P1D sub-phase owns the queue
// substrate per the ticket).

import { useCallback, useEffect, useRef, useState } from "react";

import type {
  CaseloadBody,
  CaseloadItem,
  CaseloadOpenBarrier,
  CloseBarrierResponseBody,
  CreateBarrierResponseBody,
} from "@anthos/api";
import { newIdempotencyKey } from "@anthos/domain";

import {
  applyOptimisticClose,
  applyOptimisticCreate,
  applyPriorityRecompute,
  replaceTempBarrier,
  rollbackToSnapshot,
  snapshotRow,
} from "./caseload-mutations";
import { sendMutation, type FetchLike, type MutationFailure } from "./send-mutation";

// Input shapes live with the sheet components so both this hook (caseload row)
// and the participant-detail hook can import the same types — keeping the
// shared sheets in `apps/web/app/_components/barriers/` surface-agnostic.
import type {
  CreateBarrierInput,
  CloseBarrierInput,
} from "../../_components/barriers/types";

export type { CreateBarrierInput, CloseBarrierInput, MutationFailure };

export type MutationResult =
  | { readonly outcome: "success" }
  | { readonly outcome: "failure"; readonly failure: MutationFailure };

export interface UseCaseloadMutationsResult {
  readonly items: ReadonlyArray<CaseloadItem>;
  // Participants with at least one in-flight Barrier mutation. The row uses
  // this to surface the Pattern A "Saving…" affordance — the optimistic
  // badge alone reads as a confirmed record, so a row-level indicator is
  // required while the BFF round-trip is pending.
  readonly pendingParticipantIds: ReadonlySet<string>;
  readonly createBarrier: (
    participantId: string,
    input: CreateBarrierInput,
  ) => Promise<MutationResult>;
  readonly closeBarrier: (
    participantId: string,
    input: CloseBarrierInput,
  ) => Promise<MutationResult>;
}

export interface UseCaseloadMutationsOptions {
  // Externally owned items (the parent owns the `CaseloadBody`; the hook only
  // owns the per-mutation overlay). On queue switch the parent passes the
  // next queue's items and the hook resets its overlay state — a queue
  // switch is an explicit user action that supersedes any in-flight Barrier
  // mutation.
  readonly items: ReadonlyArray<CaseloadItem>;
  readonly fetchImpl?: FetchLike;
}

export function useCaseloadMutations(
  options: UseCaseloadMutationsOptions,
): UseCaseloadMutationsResult {
  const [items, setItems] = useState<ReadonlyArray<CaseloadItem>>(options.items);
  const [pendingParticipantIds, setPendingParticipantIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const fetchImpl = options.fetchImpl ?? globalFetch;

  // Re-sync when the parent supplies a new items reference (queue switch /
  // caseload refresh). Replaces any in-flight optimistic state with the
  // authoritative queue contents.
  useEffect(() => {
    setItems(options.items);
  }, [options.items]);

  // Keep a live ref to the latest items so an in-flight mutation reconciles
  // against the most recent state in setState callbacks.
  const itemsRef = useRef<ReadonlyArray<CaseloadItem>>(items);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  const markPending = useCallback((participantId: string, pending: boolean) => {
    setPendingParticipantIds((prev) => {
      const next = new Set(prev);
      if (pending) next.add(participantId);
      else next.delete(participantId);
      return next;
    });
  }, []);

  const createBarrier = useCallback<
    UseCaseloadMutationsResult["createBarrier"]
  >(
    async (participantId, input) => {
      const snapshot = snapshotRow(itemsRef.current, participantId);
      if (snapshot === null) {
        return failureOf({
          code: "PARTICIPANT_NOT_IN_VIEW",
          message: "This participant is no longer in the current queue.",
          traceId: null,
          field: null,
          reason: null,
        });
      }

      const tempBarrierId = newOptimisticBarrierId();
      const optimistic = applyOptimisticCreate(itemsRef.current, participantId, {
        tempBarrierId,
        type: input.type,
        // Severity is server-classified — leave the optimistic insert null
        // and let `applyPriorityRecompute` + `replaceTempBarrier` carry the
        // authoritative value back to the row.
        severity: null,
        openedAtIso: new Date().toISOString(),
      });
      setItems(optimistic);
      markPending(participantId, true);

      const body: { type: string; description?: string } = { type: input.type };
      if (input.description !== undefined && input.description.length > 0) {
        body.description = input.description;
      }

      const result = await sendMutation(fetchImpl, {
        method: "POST",
        url: `/api/v1/participants/${encodeURIComponent(participantId)}/barriers`,
        idempotencyKey: newIdempotencyKey(),
        body,
      });

      if (result.kind === "failure") {
        setItems(rollbackToSnapshot(itemsRef.current, snapshot));
        markPending(participantId, false);
        return failureOf(result.failure);
      }

      const responseBody = result.body as CreateBarrierResponseBody;
      const canonical: CaseloadOpenBarrier = {
        barrierId: responseBody.barrierId,
        type: responseBody.type,
        severity: responseBody.severity,
        openedAt: responseBody.openedAt,
        ageDays: 0,
      };
      const withCanonical = replaceTempBarrier(
        itemsRef.current,
        participantId,
        tempBarrierId,
        canonical,
      );
      setItems(applyPriorityRecompute(withCanonical, responseBody.priorityRecomputed));
      markPending(participantId, false);
      return { outcome: "success" };
    },
    [fetchImpl, markPending],
  );

  const closeBarrier = useCallback<UseCaseloadMutationsResult["closeBarrier"]>(
    async (participantId, input) => {
      const snapshot = snapshotRow(itemsRef.current, participantId);
      if (snapshot === null) {
        return failureOf({
          code: "PARTICIPANT_NOT_IN_VIEW",
          message: "This participant is no longer in the current queue.",
          traceId: null,
          field: null,
          reason: null,
        });
      }

      setItems(applyOptimisticClose(itemsRef.current, participantId, input.barrierId));
      markPending(participantId, true);

      const body: { action: "close"; closureReason?: string } = {
        action: "close",
      };
      if (input.closureReason !== undefined && input.closureReason.length > 0) {
        body.closureReason = input.closureReason;
      }

      const result = await sendMutation(fetchImpl, {
        method: "PATCH",
        url: `/api/v1/participants/${encodeURIComponent(participantId)}/barriers/${encodeURIComponent(input.barrierId)}`,
        idempotencyKey: newIdempotencyKey(),
        body,
      });

      if (result.kind === "failure") {
        setItems(rollbackToSnapshot(itemsRef.current, snapshot));
        markPending(participantId, false);
        return failureOf(result.failure);
      }

      const responseBody = result.body as CloseBarrierResponseBody;
      setItems(applyPriorityRecompute(itemsRef.current, responseBody.priorityRecomputed));
      markPending(participantId, false);
      return { outcome: "success" };
    },
    [fetchImpl, markPending],
  );

  return { items, pendingParticipantIds, createBarrier, closeBarrier };
}

// Local-only id for the optimistic Barrier insert. Distinct from the
// `Idempotency-Key` sent on the wire: the temp id lives in client state and
// is swapped for the canonical SF record id on reconcile; the
// `Idempotency-Key` is the BFF dedupe key. Mixing them up would break
// `replaceTempBarrier` on a successful response — so we deliberately do NOT
// call `newIdempotencyKey()` here even though both want a fresh UUID.
function newOptimisticBarrierId(): string {
  return `optimistic:${crypto.randomUUID()}`;
}

// Helper to seed the hook directly from a `CaseloadBody`.
export function initialItemsFromBody(body: CaseloadBody): ReadonlyArray<CaseloadItem> {
  return body.items;
}

function failureOf(failure: MutationFailure): MutationResult {
  return { outcome: "failure", failure };
}

const globalFetch: FetchLike = (input, init) =>
  fetch(input as RequestInfo, init);
