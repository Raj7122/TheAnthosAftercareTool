"use client";

// P3C-14 — React glue for the offline-aware Log Case Note path. Mirrors
// `use-log-call-reconciler.ts`: gates the Outbox mirror on the tablet PWA
// surface (`isTopLevelOriginSurface()`), off on the desktop Salesforce-iframe
// surface (whose reconnect story is `/healthz` + `SyncOnReconnect`, not the
// page-side Outbox — so submits there must not leave orphan IndexedDB rows).
//
// Audit: NO client-side audit row is emitted. The BFF writes a Pattern B
// `case_note.created` row BEFORE the response on every reachable outcome
// (SUCCESS + FAILED), same posture as the Log Call reconciler.

import { useCallback, useRef } from "react";

import {
  useCaseNoteMutation,
} from "../../_components/case-notes/useCaseNoteMutation";
import type {
  CreateCaseNoteInput,
  MutationFailure,
} from "../../_components/case-notes/types";

import { enqueue, remove } from "../offline/outbox";
import { isTopLevelOriginSurface } from "../offline/pwa-surface";
import { flashSynced } from "../offline/replay";

import { reconcileCaseNoteWithOutboxMirror } from "./with-outbox-mirror";

export interface UseCaseNoteReconcilerOptions {
  // P3C-14 — Outbox mirror toggle (Pattern C/D). Defaults to the tablet PWA
  // surface; tests force the boolean.
  readonly outboxMirror?: boolean;
}

export interface UseCaseNoteReconcilerResult {
  // Returns `null` when the note is confirmed OR safely queued offline (the
  // caller closes the sheet in both cases); a structured failure only on a
  // genuine server rejection (the sheet stays open + surfaces it).
  readonly reconcileCaseNote: (
    participantId: string,
    idempotencyKey: string,
    input: CreateCaseNoteInput,
  ) => Promise<MutationFailure | null>;
}

export function useCaseNoteReconciler(
  options: UseCaseNoteReconcilerOptions = {},
): UseCaseNoteReconcilerResult {
  const { createCaseNote } = useCaseNoteMutation();

  // Stash the latest mutation on a ref so the returned callback identity is
  // stable across renders (sheets memo on callback identity).
  const createRef = useRef(createCaseNote);
  createRef.current = createCaseNote;

  const mirrorEnabled = options.outboxMirror ?? isTopLevelOriginSurface();
  const mirrorRef = useRef<boolean>(mirrorEnabled);
  mirrorRef.current = mirrorEnabled;

  const reconcile = useCallback<
    UseCaseNoteReconcilerResult["reconcileCaseNote"]
  >(async (participantId, idempotencyKey, input) => {
    // Single-shot create mapped to `MutationFailure | null` (no optimistic
    // loop). Reuses the in-flight idempotency key so a reconnect replay dedupes.
    const runCreate = async (): Promise<MutationFailure | null> => {
      const result = await createRef.current(participantId, input, idempotencyKey);
      return result.outcome === "failure" ? result.failure : null;
    };

    if (!mirrorRef.current) {
      return runCreate();
    }

    const failure = await reconcileCaseNoteWithOutboxMirror(
      { enqueue, markSynced: (row) => flashSynced(row), discard: remove },
      participantId,
      idempotencyKey,
      input,
      runCreate,
    );
    // Offline-first: a NETWORK_ERROR means the mirror kept the note queued
    // (visible as "Queued · will sync" and replayed on reconnect), so we report
    // success — the sheet closes instead of flashing a scary network error.
    // Genuine server rejections still propagate to the sheet.
    if (failure !== null && failure.code === "NETWORK_ERROR") {
      return null;
    }
    return failure;
  }, []);

  return { reconcileCaseNote: reconcile };
}
