"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { newIdempotencyKey } from "@anthos/domain";

import type { MutationFailure } from "../../caseload/_lib/send-mutation";
import {
  useScheduleVisitMutation,
  useSendEmailMutation,
  useSendSmsMutation,
} from "../../caseload/_lib/useCommsMutations";
import type { CommsChannel, OptimisticSend } from "../../_lib/comms/types";
import type { OptimisticRepair } from "../repairs/types";
import type { OptimisticCaseNote } from "../case-notes/types";
import { useDraftStore } from "../../_lib/offline/drafts/store";
import { LogCallSheet } from "../../caseload/_components/LogCallSheet";
import { EmailSheet } from "./EmailSheet";
import { ScheduleSheet } from "./ScheduleSheet";
import { SmsSheet } from "./SmsSheet";

// P1H-11 — context backing the participant communications workflow.
//
// WIRED (P1H-11 frontend): SMS / Email / Schedule sends now hit the real BFF
// endpoints (E-11 / E-12 / E-13) with Pattern A optimistic reconciliation —
// the row is added immediately, then confirmed (server id + trace id stamped)
// on success or rolled back on failure, with the failure surfaced inline in the
// sheet so it stays open. The Idempotency-Key is minted once per sheet-open
// (Pattern D) and reused across in-sheet retries; the quiet-hours "schedule for
// later" re-submit mints a fresh key because its body changes. The Log-a-Call
// sheet remains client-only here (the caseload view owns its real reconciler).
//
// Optimistic sends still live in component state (reset on reload) — the
// authoritative record is the Salesforce write the BFF performed; this list is
// the in-session Recent-Contacts surface.

interface ParticipantCommsContextValue {
  readonly openCompose: (channel: CommsChannel) => void;
  readonly optimisticSends: ReadonlyArray<OptimisticSend>;
  // This session's logged repairs, surfaced "via tool" in the timeline. The
  // RepairsPanel publishes here on a successful Repair__c write so the
  // collapsible "Repair logged at <date>" row appears immediately.
  readonly optimisticRepairs: ReadonlyArray<OptimisticRepair>;
  readonly addRepair: (repair: OptimisticRepair) => void;
  // Same, for this session's logged case notes — the CaseNotesPanel publishes
  // here so the collapsible "Case note logged at <date>" timeline row appears.
  readonly optimisticCaseNotes: ReadonlyArray<OptimisticCaseNote>;
  readonly addCaseNote: (caseNote: OptimisticCaseNote) => void;
}

const Context = createContext<ParticipantCommsContextValue | null>(null);

interface Props {
  readonly participantId: string;
  readonly specialistId: string;
  readonly displayName: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly initialCompose: CommsChannel | null;
  readonly children: ReactNode;
}

export function ParticipantCommsProvider({
  participantId,
  specialistId,
  displayName,
  phone,
  email,
  initialCompose,
  children,
}: Props) {
  const [openChannel, setOpenChannel] = useState<CommsChannel | null>(initialCompose);
  const [optimisticSends, setOptimisticSends] = useState<ReadonlyArray<OptimisticSend>>([]);
  const [optimisticRepairs, setOptimisticRepairs] = useState<
    ReadonlyArray<OptimisticRepair>
  >([]);
  const [optimisticCaseNotes, setOptimisticCaseNotes] = useState<
    ReadonlyArray<OptimisticCaseNote>
  >([]);
  // Pattern D key, minted once per sheet-open and reused across in-sheet
  // retries. `initialCompose` deep-links open a sheet, so seed a key eagerly.
  const [composeKey, setComposeKey] = useState<string>(() =>
    initialCompose !== null ? newIdempotencyKey() : "",
  );

  const { sendSms } = useSendSmsMutation();
  const { sendEmail } = useSendEmailMutation();
  const { scheduleVisit } = useScheduleVisitMutation();

  const openCompose = useCallback((channel: CommsChannel) => {
    setComposeKey(newIdempotencyKey());
    setOpenChannel(channel);
  }, []);

  const close = useCallback(() => setOpenChannel(null), []);

  // Adds an optimistic row immediately and returns its id so the caller can
  // confirm (stamp server id) or roll it back. Does NOT close the sheet — the
  // submit handler closes on success so a failure leaves the sheet open.
  const addSend = useCallback((send: Omit<OptimisticSend, "id" | "timestamp">): string => {
    const id = newSendId();
    const record: OptimisticSend = { ...send, id, timestamp: new Date().toISOString() };
    setOptimisticSends((prev) => [record, ...prev]);
    return id;
  }, []);

  const updateSend = useCallback((id: string, patch: Partial<OptimisticSend>) => {
    setOptimisticSends((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  }, []);

  const removeSend = useCallback((id: string) => {
    setOptimisticSends((prev) => prev.filter((s) => s.id !== id));
  }, []);

  const addRepair = useCallback((repair: OptimisticRepair) => {
    setOptimisticRepairs((prev) => [repair, ...prev]);
  }, []);

  const addCaseNote = useCallback((caseNote: OptimisticCaseNote) => {
    setOptimisticCaseNotes((prev) => [caseNote, ...prev]);
  }, []);

  const value = useMemo<ParticipantCommsContextValue>(
    () => ({
      openCompose,
      optimisticSends,
      optimisticRepairs,
      addRepair,
      optimisticCaseNotes,
      addCaseNote,
    }),
    [
      openCompose,
      optimisticSends,
      optimisticRepairs,
      addRepair,
      optimisticCaseNotes,
      addCaseNote,
    ],
  );

  // ── Submit handlers (optimistic add → reconcile) ──────────────────────────
  const onSendSms = useCallback(
    async (body: string, scheduledFor?: string): Promise<MutationFailure | null> => {
      const id = addSend({
        channel: "sms",
        label: "Outbound SMS",
        summary: body,
        status: scheduledFor !== undefined ? "Scheduled" : "Sent",
      });
      // A scheduled re-submit changes the body → fresh key (Pattern D: same key
      // with a different payload is a 422 IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD).
      const key = scheduledFor !== undefined ? newIdempotencyKey() : composeKey;
      const res = await sendSms(participantId, key, {
        body,
        ...(scheduledFor !== undefined ? { scheduledFor } : {}),
      });
      if (res.outcome === "failure") {
        removeSend(id);
        return res.failure;
      }
      updateSend(id, {
        serverId: res.body.smsId,
        traceId: res.traceId,
        status: res.body.deliveryStatus === "scheduled" ? "Scheduled" : "Sent",
      });
      useDraftStore.getState().clearSmsComposeDraft(specialistId, participantId);
      close();
      return null;
    },
    [addSend, close, composeKey, participantId, removeSend, sendSms, specialistId, updateSend],
  );

  const onSendEmail = useCallback(
    async (subject: string, body: string): Promise<MutationFailure | null> => {
      const id = addSend({ channel: "email", label: "Email", summary: subject, status: "Sent" });
      const res = await sendEmail(participantId, composeKey, { subject, body });
      if (res.outcome === "failure") {
        removeSend(id);
        return res.failure;
      }
      updateSend(id, { serverId: res.body.activityId, traceId: res.traceId });
      useDraftStore.getState().clearEmailComposeDraft(specialistId, participantId);
      close();
      return null;
    },
    [addSend, close, composeKey, participantId, removeSend, sendEmail, specialistId, updateSend],
  );

  const onScheduleVisit = useCallback(
    async (visit: { date: string; type: string; notes: string }): Promise<MutationFailure | null> => {
      // The sheet captures a date; the endpoint takes an ISO datetime and
      // derives the Service_Date__c. Noon-UTC keeps the calendar date stable.
      const scheduledDateTime = `${visit.date}T12:00:00.000Z`;
      const id = addSend({
        channel: "schedule",
        label: visit.type,
        summary: visit.notes.trim().length > 0 ? visit.notes : `Scheduled for ${visit.date}`,
        status: "Scheduled",
        eventDate: visit.date,
      });
      const res = await scheduleVisit(participantId, composeKey, {
        scheduledDateTime,
        notes: visit.notes,
      });
      if (res.outcome === "failure") {
        removeSend(id);
        return res.failure;
      }
      updateSend(id, { serverId: res.body.visitId, traceId: res.traceId });
      useDraftStore.getState().clearScheduleVisitDraft(specialistId, participantId);
      close();
      return null;
    },
    [addSend, close, composeKey, participantId, removeSend, scheduleVisit, specialistId, updateSend],
  );

  return (
    <Context.Provider value={value}>
      {children}
      {openChannel === "sms" && (
        <SmsSheet
          participantId={participantId}
          specialistId={specialistId}
          displayName={displayName}
          phone={phone}
          onCancel={close}
          onSend={onSendSms}
        />
      )}
      {openChannel === "email" && (
        <EmailSheet
          participantId={participantId}
          specialistId={specialistId}
          displayName={displayName}
          email={email}
          onCancel={close}
          onSend={onSendEmail}
        />
      )}
      {openChannel === "call" && (
        <LogCallSheet
          participantId={participantId}
          displayName={displayName}
          specialistId={specialistId}
          idempotencyKey={composeKey}
          onCancel={close}
          onSubmit={async (input) => {
            // Log-a-Call stays client-only here (the caseload view owns the
            // real F-08 reconciler); surface it as an optimistic phone event.
            addSend({
              channel: "call",
              label: input.type,
              summary:
                input.summary !== undefined && input.summary.trim() !== ""
                  ? input.summary
                  : input.status,
              status: input.status,
              eventDate: input.serviceDate,
            });
            useDraftStore.getState().clearLogCallDraft(specialistId, participantId);
            close();
            return null;
          }}
        />
      )}
      {openChannel === "schedule" && (
        <ScheduleSheet
          participantId={participantId}
          specialistId={specialistId}
          displayName={displayName}
          onCancel={close}
          onSend={onScheduleVisit}
        />
      )}
    </Context.Provider>
  );
}

export function useParticipantComms(): ParticipantCommsContextValue {
  const ctx = useContext(Context);
  if (ctx === null) {
    throw new Error("useParticipantComms must be used inside <ParticipantCommsProvider>.");
  }
  return ctx;
}

const newSendId: () => string = (() => {
  let counter = 0;
  return function newSendIdInner(): string {
    const c = globalThis.crypto as Crypto | undefined;
    if (c !== undefined && typeof c.randomUUID === "function") {
      return `send:${c.randomUUID()}`;
    }
    counter += 1;
    return `send:${Date.now()}-${counter}`;
  };
})();
