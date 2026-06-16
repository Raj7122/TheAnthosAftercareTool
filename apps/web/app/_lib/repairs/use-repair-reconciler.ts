"use client";

// React glue for the offline-aware Add Repair path (Pattern C/D). Mirrors
// `case-notes/use-case-note-reconciler.ts`: gates the Outbox mirror on the
// tablet PWA surface (`isTopLevelOriginSurface()`), off on the desktop
// Salesforce-iframe surface (whose reconnect story is `/healthz` +
// `SyncOnReconnect`, not the page-side Outbox — so submits there must not leave
// orphan IndexedDB rows).
//
// Audit: NO client-side audit row is emitted. The BFF writes a Pattern B
// `repair.created` row BEFORE the response on every reachable outcome
// (SUCCESS + FAILED), same posture as the Log Case Note reconciler.

import { useCallback, useRef } from "react";

import { useRepairMutation } from "../../_components/repairs/useRepairMutation";
import type {
  CreateRepairInput,
  MutationFailure,
} from "../../_components/repairs/types";

import { enqueue, remove } from "../offline/outbox";
import { isTopLevelOriginSurface } from "../offline/pwa-surface";
import { flashSynced } from "../offline/replay";

import { reconcileRepairWithOutboxMirror } from "./with-outbox-mirror";

export interface UseRepairReconcilerOptions {
  // Outbox mirror toggle (Pattern C/D). Defaults to the tablet PWA surface;
  // tests force the boolean.
  readonly outboxMirror?: boolean;
}

export interface UseRepairReconcilerResult {
  // Returns `null` when the repair is confirmed OR safely queued offline (the
  // caller closes the sheet in both cases); a structured failure only on a
  // genuine server rejection (the sheet stays open + surfaces it).
  readonly reconcileRepair: (
    participantId: string,
    idempotencyKey: string,
    input: CreateRepairInput,
  ) => Promise<MutationFailure | null>;
}

export function useRepairReconciler(
  options: UseRepairReconcilerOptions = {},
): UseRepairReconcilerResult {
  const { createRepair } = useRepairMutation();

  // Stash the latest mutation on a ref so the returned callback identity is
  // stable across renders (sheets memo on callback identity).
  const createRef = useRef(createRepair);
  createRef.current = createRepair;

  const mirrorEnabled = options.outboxMirror ?? isTopLevelOriginSurface();
  const mirrorRef = useRef<boolean>(mirrorEnabled);
  mirrorRef.current = mirrorEnabled;

  const reconcile = useCallback<UseRepairReconcilerResult["reconcileRepair"]>(
    async (participantId, idempotencyKey, input) => {
      // Single-shot create mapped to `MutationFailure | null` (no optimistic
      // loop). Reuses the in-flight idempotency key so a reconnect replay
      // dedupes.
      const runCreate = async (): Promise<MutationFailure | null> => {
        const result = await createRef.current(
          participantId,
          input,
          idempotencyKey,
        );
        return result.outcome === "failure" ? result.failure : null;
      };

      if (!mirrorRef.current) {
        return runCreate();
      }

      const failure = await reconcileRepairWithOutboxMirror(
        { enqueue, markSynced: (row) => flashSynced(row), discard: remove },
        participantId,
        idempotencyKey,
        input,
        runCreate,
      );
      // Offline-first: a NETWORK_ERROR means the mirror kept the repair queued
      // (visible as "Queued · will sync" and replayed on reconnect), so we
      // report success — the sheet closes instead of flashing a scary network
      // error. Genuine server rejections still propagate to the sheet.
      if (failure !== null && failure.code === "NETWORK_ERROR") {
        return null;
      }
      return failure;
    },
    [],
  );

  return { reconcileRepair: reconcile };
}
