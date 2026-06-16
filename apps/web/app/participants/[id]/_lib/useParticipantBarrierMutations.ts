"use client";

// Pattern A optimistic-UI hook for F-06 Barrier create/close on the F-07
// detail page. Mirrors the contract of
// `apps/web/app/caseload/_lib/useCaseloadMutations.ts` but operates on a
// single `ParticipantDetailBody` instead of `CaseloadItem[]`. The sheets in
// `apps/web/app/_components/barriers/` consume either hook through the
// shared `CreateBarrierInput` / `CloseBarrierInput` / `MutationFailure`
// types in `_components/barriers/types.ts`.
//
// One `Idempotency-Key` per user action (TR-OFFLINE-6a + Immutable #6) —
// generated at submission, not at network send, so a transparent middleware
// retry against the BFF lands on the same idempotency row. Offline-queue
// fan-out is out of scope (P1D substrate); a Network/5xx-exhausted error
// surfaces to the sheet as a terminal failure.

import { useCallback, useEffect, useRef, useState } from "react";

import type {
  CaseloadOpenBarrier,
  CloseBarrierResponseBody,
  CreateBarrierResponseBody,
  ParticipantDetailBody,
} from "@anthos/api";
import { newIdempotencyKey } from "@anthos/domain";

import {
  sendMutation,
  type FetchLike,
  type MutationFailure,
} from "../../../caseload/_lib/send-mutation";
import type {
  CloseBarrierInput,
  CreateBarrierInput,
} from "../../../_components/barriers/types";
import {
  applyOptimisticClose,
  applyOptimisticCreate,
  applyPriorityRecompute,
  replaceTempBarrier,
  rollbackToSnapshot,
  snapshotDetailBody,
} from "./participant-barrier-mutations";

export type MutationResult =
  | { readonly outcome: "success" }
  | { readonly outcome: "failure"; readonly failure: MutationFailure };

export interface UseParticipantBarrierMutationsResult {
  readonly body: ParticipantDetailBody;
  // True while any create/close round-trip is in flight. The panel uses this
  // to surface a Pattern A "Saving…" affordance — the optimistic insert /
  // removal alone reads as a confirmed record, so a panel-level indicator is
  // required while the BFF round-trip is pending.
  readonly isPending: boolean;
  readonly closingBarrierIds: ReadonlySet<string>;
  readonly createBarrier: (input: CreateBarrierInput) => Promise<MutationResult>;
  readonly closeBarrier: (input: CloseBarrierInput) => Promise<MutationResult>;
}

export interface UseParticipantBarrierMutationsOptions {
  readonly initialBody: ParticipantDetailBody;
  readonly fetchImpl?: FetchLike;
}

export function useParticipantBarrierMutations(
  options: UseParticipantBarrierMutationsOptions,
): UseParticipantBarrierMutationsResult {
  const [body, setBody] = useState<ParticipantDetailBody>(options.initialBody);
  const [pendingCount, setPendingCount] = useState(0);
  const [closingBarrierIds, setClosingBarrierIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const fetchImpl = options.fetchImpl ?? globalFetch;

  // Re-sync when the parent supplies a new body (page revalidation /
  // caseload refresh effects). Replaces any in-flight optimistic state with
  // the authoritative server body.
  useEffect(() => {
    setBody(options.initialBody);
  }, [options.initialBody]);

  // Keep a live ref to the latest body so an in-flight mutation reconciles
  // against the most recent state in setState callbacks.
  const bodyRef = useRef<ParticipantDetailBody>(body);
  useEffect(() => {
    bodyRef.current = body;
  }, [body]);

  const incrementPending = useCallback(() => {
    setPendingCount((n) => n + 1);
  }, []);
  const decrementPending = useCallback(() => {
    setPendingCount((n) => Math.max(0, n - 1));
  }, []);

  const markClosing = useCallback((barrierId: string, closing: boolean) => {
    setClosingBarrierIds((prev) => {
      const next = new Set(prev);
      if (closing) next.add(barrierId);
      else next.delete(barrierId);
      return next;
    });
  }, []);

  const createBarrier = useCallback<
    UseParticipantBarrierMutationsResult["createBarrier"]
  >(
    async (input) => {
      const current = bodyRef.current;
      const snapshot = snapshotDetailBody(current);
      const participantId = current.participantId;
      const tempBarrierId = newOptimisticBarrierId();
      const optimistic = applyOptimisticCreate(current, {
        tempBarrierId,
        type: input.type,
        // Severity is server-classified — leave the optimistic insert null
        // and let `applyPriorityRecompute` + `replaceTempBarrier` carry the
        // authoritative value back to the panel.
        severity: null,
        openedAtIso: new Date().toISOString(),
      });
      setBody(optimistic);
      incrementPending();

      const requestBody: { type: string; description?: string } = {
        type: input.type,
      };
      if (input.description !== undefined && input.description.length > 0) {
        requestBody.description = input.description;
      }

      const result = await sendMutation(fetchImpl, {
        method: "POST",
        url: `/api/v1/participants/${encodeURIComponent(participantId)}/barriers`,
        idempotencyKey: newIdempotencyKey(),
        body: requestBody,
      });

      if (result.kind === "failure") {
        setBody(rollbackToSnapshot(bodyRef.current, snapshot));
        decrementPending();
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
        bodyRef.current,
        tempBarrierId,
        canonical,
      );
      setBody(applyPriorityRecompute(withCanonical, responseBody.priorityRecomputed));
      decrementPending();
      return { outcome: "success" };
    },
    [decrementPending, fetchImpl, incrementPending],
  );

  const closeBarrier = useCallback<
    UseParticipantBarrierMutationsResult["closeBarrier"]
  >(
    async (input) => {
      const current = bodyRef.current;
      const snapshot = snapshotDetailBody(current);
      const participantId = current.participantId;

      setBody(applyOptimisticClose(current, input.barrierId));
      incrementPending();
      markClosing(input.barrierId, true);

      const requestBody: { action: "close"; closureReason?: string } = {
        action: "close",
      };
      if (input.closureReason !== undefined && input.closureReason.length > 0) {
        requestBody.closureReason = input.closureReason;
      }

      const result = await sendMutation(fetchImpl, {
        method: "PATCH",
        url: `/api/v1/participants/${encodeURIComponent(participantId)}/barriers/${encodeURIComponent(input.barrierId)}`,
        idempotencyKey: newIdempotencyKey(),
        body: requestBody,
      });

      if (result.kind === "failure") {
        setBody(rollbackToSnapshot(bodyRef.current, snapshot));
        decrementPending();
        markClosing(input.barrierId, false);
        return failureOf(result.failure);
      }

      const responseBody = result.body as CloseBarrierResponseBody;
      setBody(applyPriorityRecompute(bodyRef.current, responseBody.priorityRecomputed));
      decrementPending();
      markClosing(input.barrierId, false);
      return { outcome: "success" };
    },
    [decrementPending, fetchImpl, incrementPending, markClosing],
  );

  return {
    body,
    isPending: pendingCount > 0,
    closingBarrierIds,
    createBarrier,
    closeBarrier,
  };
}

// Local-only id for the optimistic Barrier insert. Distinct from the
// `Idempotency-Key` sent on the wire: the temp id lives in client state and
// is swapped for the canonical SF record id on reconcile; the
// `Idempotency-Key` is the BFF dedupe key — so we deliberately do NOT call
// `newIdempotencyKey()` here even though both want a fresh UUID.
function newOptimisticBarrierId(): string {
  return `optimistic:${crypto.randomUUID()}`;
}

function failureOf(failure: MutationFailure): MutationResult {
  return { outcome: "failure", failure };
}

const globalFetch: FetchLike = (input, init) =>
  fetch(input as RequestInfo, init);
