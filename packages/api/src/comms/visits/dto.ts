// Wire shapes for the visit endpoints per API v1.3:
//   E-13  POST /participants/:id/visits                 — schedule a Stability Visit
//   E-38  POST /participants/:id/visits/propose-times   — propose 3 candidate times
//   P3A-03 POST /participants/:id/visits/:visitId/log    — log a completed visit
//
// Data model (ERD v1.4, GAP-8 resolved): there is NO separate Stability Visit
// object — a visit is an `IDW_Case_Note__c` with `Type='Stability Meeting'`.
// Scheduling writes Status='Scheduled'; logging flips it to 'Completed' and adds
// a `Survey__c`. (Scheduled-visit storage was [TBD-v1.12-3]; representing it as a
// Status='Scheduled' Case Note is this build's defensible default — flagged.)
//
// Outlook (MS Graph) is unavailable in Demo → outlookEventId is null and
// propose-times is deterministic with fallbackUsed=true.

import { z } from "zod";

import type { CheckpointAnchor } from "@anthos/domain";

// ── E-13 schedule ───────────────────────────────────────────────────────────
const NOTES_MAX_LEN = 2000;
const LOCATION_MAX_LEN = 255;

export const scheduleVisitRequestSchema = z
  .object({
    scheduledDateTime: z.string().datetime({ offset: true }),
    location: z.string().max(LOCATION_MAX_LEN).optional(),
    notes: z.string().max(NOTES_MAX_LEN).optional(),
    estimatedDurationMinutes: z.number().int().positive().max(480).optional(),
  })
  .strict();

export type ScheduleVisitRequest = z.infer<typeof scheduleVisitRequestSchema>;

export type ParticipantNotificationChannel = "sms" | "email" | "none";
export type ParticipantNotificationStatus = "sent" | "skipped" | "degraded";

export interface ScheduleVisitResponseBody {
  readonly visitId: string;
  // Null in Demo (MS Graph degraded); the Graph event id when Outlook is live.
  readonly outlookEventId: string | null;
  // Null when no participant confirmation was sent (Demo default).
  readonly smsConfirmationId: string | null;
  readonly scheduledDateTime: string;
  readonly participantNotificationChannel: ParticipantNotificationChannel;
  readonly participantNotificationStatus: ParticipantNotificationStatus;
  readonly statusLabel: string;
  // True when the Salesforce visit was written but Outlook was unavailable.
  readonly outlookDegraded: boolean;
}

// ── E-38 propose-times ────────────────────────────────────────────────────────
const HHMM_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const preferredWindowSchema = z
  .object({
    // 0=Sunday … 6=Saturday (JS getUTCDay convention).
    dayOfWeek: z.number().int().min(0).max(6),
    startTime: z.string().regex(HHMM_RE, "startTime must be HH:mm"),
    endTime: z.string().regex(HHMM_RE, "endTime must be HH:mm"),
  })
  .strict();

export const proposeTimesRequestSchema = z
  .object({
    weekStarting: z.string().regex(ISO_DATE_RE, "weekStarting must be YYYY-MM-DD"),
    preferredWindowsLocal: z.array(preferredWindowSchema).min(1).max(21),
    estimatedDurationMinutes: z.number().int().positive().max(480),
    participantTimezone: z.string().min(1),
    maxSuggestions: z.number().int().positive().max(10).optional(),
  })
  .strict();

export type ProposeTimesRequest = z.infer<typeof proposeTimesRequestSchema>;

export interface ProposedSlot {
  readonly slotStart: string; // ISO-8601 UTC
  readonly slotEnd: string; // ISO-8601 UTC
  readonly specialistTimezone: string;
  readonly rank: number;
  readonly rationale: string;
}

export interface ProposeTimesResponseBody {
  readonly proposedSlots: ReadonlyArray<ProposedSlot>;
  // Seconds since the Graph free/busy probe; 0 when fallback (no Graph) was used.
  readonly graphFreshnessSeconds: number;
  // True when slots were generated deterministically (MS Graph unavailable).
  readonly fallbackUsed: boolean;
  // When fewer than the requested number of slots are returnable, a typed reason.
  readonly insufficientReason: string | null;
}

// ── P3A-03 log ────────────────────────────────────────────────────────────────
// Survey block — all optional for Demo (Survey__c has no required fields beyond
// optional lookups; mandatory-field provenance is owed by Erick, I-06).
export const visitSurveySchema = z
  .object({
    housingStability: z.string().max(255).optional(),
    incomeStatus: z.string().max(255).optional(),
    supportConnections: z.string().max(255).optional(),
    barriersObserved: z.string().max(2000).optional(),
  })
  .strict();

export const logVisitRequestSchema = z
  .object({
    occurredAt: z.string().datetime({ offset: true }).optional(),
    summary: z.string().max(NOTES_MAX_LEN).optional(),
    survey: visitSurveySchema.optional(),
  })
  .strict();

export type LogVisitRequest = z.infer<typeof logVisitRequestSchema>;

export interface LogVisitResponseBody {
  readonly visitId: string;
  readonly surveyId: string | null;
  // The credited checkpoint anchor (90/180/270/365) or null when the visit
  // falls before the first checkpoint (held) — BR-25 via `creditCheckpoint`.
  readonly checkpointCredited: CheckpointAnchor | null;
  readonly status: string;
  readonly loggedAt: string;
}
