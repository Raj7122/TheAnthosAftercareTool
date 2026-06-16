"use client";

// P1H-11 — submit hooks for the SMS / Email / Schedule comms sheets. Each
// mirrors `useLogCallMutation`: a pure `submit*` helper (request shaping +
// envelope mapping, unit-testable without React) plus a thin `useCallback`
// hook. The Idempotency-Key is minted by the sheet's parent (ParticipantComms
// Provider) at sheet-open and passed in — reused across in-sheet retries
// (Pattern D), except the quiet-hours "schedule for later" re-submit, which
// mints a fresh key (the body — and thus the request hash — changes).

import { useCallback } from "react";

import type {
  ScheduleVisitResponseBody,
  SendEmailResponseBody,
  SendSmsResponseBody,
} from "@anthos/api";

import {
  sendMutation,
  type FetchLike,
  type MutationFailure,
} from "./send-mutation";

const globalFetch: FetchLike = (...args) => fetch(...args);

function pid(participantId: string): string {
  return encodeURIComponent(participantId);
}

// ── SMS (E-11) ────────────────────────────────────────────────────────────
export interface SendSmsInput {
  readonly body: string;
  readonly templateKey?: string;
  // Set on the quiet-hours "schedule for the next window" re-submit.
  readonly scheduledFor?: string;
}

export type SendSmsResult =
  | { readonly outcome: "success"; readonly body: SendSmsResponseBody; readonly traceId: string | null }
  | { readonly outcome: "failure"; readonly failure: MutationFailure };

export async function submitSendSms(
  fetchImpl: FetchLike,
  participantId: string,
  idempotencyKey: string,
  input: SendSmsInput,
): Promise<SendSmsResult> {
  const body: Record<string, unknown> = { body: input.body };
  if (input.templateKey !== undefined) body.templateKey = input.templateKey;
  if (input.scheduledFor !== undefined) body.scheduledFor = input.scheduledFor;

  const result = await sendMutation(fetchImpl, {
    method: "POST",
    url: `/api/v1/participants/${pid(participantId)}/sms`,
    idempotencyKey,
    body,
  });
  if (result.kind === "failure") return { outcome: "failure", failure: result.failure };
  return { outcome: "success", body: result.body as SendSmsResponseBody, traceId: result.traceId };
}

export function useSendSmsMutation(options?: { fetchImpl?: FetchLike }) {
  const fetchImpl = options?.fetchImpl ?? globalFetch;
  const sendSms = useCallback(
    (participantId: string, idempotencyKey: string, input: SendSmsInput) =>
      submitSendSms(fetchImpl, participantId, idempotencyKey, input),
    [fetchImpl],
  );
  return { sendSms };
}

// ── Email (E-12) ────────────────────────────────────────────────────────────
export interface SendEmailInput {
  readonly subject: string;
  readonly body: string;
  readonly templateKey?: string;
}

export type SendEmailResult =
  | { readonly outcome: "success"; readonly body: SendEmailResponseBody; readonly traceId: string | null }
  | { readonly outcome: "failure"; readonly failure: MutationFailure };

export async function submitSendEmail(
  fetchImpl: FetchLike,
  participantId: string,
  idempotencyKey: string,
  input: SendEmailInput,
): Promise<SendEmailResult> {
  const body: Record<string, unknown> = { subject: input.subject, body: input.body };
  if (input.templateKey !== undefined) body.templateKey = input.templateKey;

  const result = await sendMutation(fetchImpl, {
    method: "POST",
    url: `/api/v1/participants/${pid(participantId)}/emails`,
    idempotencyKey,
    body,
  });
  if (result.kind === "failure") return { outcome: "failure", failure: result.failure };
  return { outcome: "success", body: result.body as SendEmailResponseBody, traceId: result.traceId };
}

export function useSendEmailMutation(options?: { fetchImpl?: FetchLike }) {
  const fetchImpl = options?.fetchImpl ?? globalFetch;
  const sendEmail = useCallback(
    (participantId: string, idempotencyKey: string, input: SendEmailInput) =>
      submitSendEmail(fetchImpl, participantId, idempotencyKey, input),
    [fetchImpl],
  );
  return { sendEmail };
}

// ── Schedule visit (E-13) ─────────────────────────────────────────────────────
export interface ScheduleVisitInput {
  readonly scheduledDateTime: string; // ISO-8601
  readonly notes?: string;
}

export type ScheduleVisitResult =
  | { readonly outcome: "success"; readonly body: ScheduleVisitResponseBody; readonly traceId: string | null }
  | { readonly outcome: "failure"; readonly failure: MutationFailure };

export async function submitScheduleVisit(
  fetchImpl: FetchLike,
  participantId: string,
  idempotencyKey: string,
  input: ScheduleVisitInput,
): Promise<ScheduleVisitResult> {
  const body: Record<string, unknown> = { scheduledDateTime: input.scheduledDateTime };
  if (input.notes !== undefined && input.notes.length > 0) body.notes = input.notes;

  const result = await sendMutation(fetchImpl, {
    method: "POST",
    url: `/api/v1/participants/${pid(participantId)}/visits`,
    idempotencyKey,
    body,
  });
  if (result.kind === "failure") return { outcome: "failure", failure: result.failure };
  return { outcome: "success", body: result.body as ScheduleVisitResponseBody, traceId: result.traceId };
}

export function useScheduleVisitMutation(options?: { fetchImpl?: FetchLike }) {
  const fetchImpl = options?.fetchImpl ?? globalFetch;
  const scheduleVisit = useCallback(
    (participantId: string, idempotencyKey: string, input: ScheduleVisitInput) =>
      submitScheduleVisit(fetchImpl, participantId, idempotencyKey, input),
    [fetchImpl],
  );
  return { scheduleVisit };
}
