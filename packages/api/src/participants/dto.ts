// Participant-detail wire DTO assembly (P1F-01, E-08; F-07).
//
// Builds the §7.4.1 response body from the identity row + the engine-scored
// snapshot. The factor / invariant / stabilityVisit / openBarriers / tags
// blocks REUSE the caseload-row builders so the SPA can drive a single
// renderer across the queue and the detail page (per the ticket's "Notes for
// the implementing agent").
//
// PII (Immutable #1): identity fields appear on this body by design — E-08 is
// the spec-mandated source for the detail view (BR-40 entitlement parity). The
// detail response is NOT cached server-side (no `caseload_cache` write-through
// here); it is `Cache-Control: no-store` on the wire.

import {
  deriveRowTags,
  type Configuration,
  type EngineOutput,
  type RowTag,
} from "@anthos/domain";
import type { Role } from "@anthos/auth";
import type { CaseloadSnapshot } from "@anthos/integrations";

import { toIsoDate, wholeDaysBetween } from "../caseload/dates.js";
import {
  adaptFactor,
  adaptHighestImpact,
  adaptInvariant,
  buildCycleStatus,
  buildOpenBarriers,
  buildPerCheckpointBreakdown,
  buildRowTagSnapshot,
  buildStabilityVisit,
  type CaseloadCycleStatus,
  type CaseloadFactor,
  type CaseloadHighestImpactFactor,
  type CaseloadOpenBarrier,
  type CaseloadStabilityVisit,
  type CaseloadTriggeredInvariant,
  type PerCheckpointBreakdownDto,
} from "../caseload/dto.js";
import type { ParticipantIdentity } from "./identity-hydration.js";

// Postal-address envelope. All four parts nullable so partial sandbox data
// renders without coercion. Sourced from SF Contact mailing fields once a
// future ticket grants Contact read scope — until then, returned as nulls
// (the PE formula fields surface name/phone/email but not address).
export interface ParticipantAddress {
  readonly street: string | null;
  readonly city: string | null;
  readonly state: string | null;
  readonly zip: string | null;
}

export interface ParticipantContact {
  readonly phone: string | null;
  // `phoneRevealable` stays `false` until a reveal-permission mechanism
  // exists. The phone field itself is returned unmasked here — UI-side
  // masking is the SPA's job (BR-40 already mirrors caller entitlement; an
  // additional reveal gate is the v1.4+ concern).
  readonly phoneRevealable: boolean;
  readonly email: string | null;
  readonly address: ParticipantAddress;
}

// `communicationConsent` stubbed `null` per the P1F-01 plan — no confirmed
// SF source for SMS / email consent flags today; Mogli owns the SMS consent
// state per PRD §11 but its data is not on PE or Contact (per work-note grep
// 2026-05-23). The envelope shape is preserved so the SPA can detect "unknown"
// vs "explicit false" once a source lands.
export interface CommunicationConsent {
  readonly sms: boolean | null;
  readonly email: boolean | null;
  readonly smsConsentVerifiedAt: string | null;
}

// `preferredContactMethod` similarly stubs null — FS_v1_12 D-04 explicitly
// flags this as unresolved; no SF field exists today.
export type PreferredContactMethod = "phone" | "email" | "text" | null;

// One row of the §7.4.1 `recentContacts[]` block. Today's PE rollup gives
// at most one row (the most recent case note); see note on
// `buildRecentContactsFromIdentity` for the schema-gap context.
export interface ParticipantRecentContact {
  readonly contactId: string | null;
  readonly type: "case_note";
  readonly caseNoteType: string | null;
  readonly contactType: string | null;
  readonly channel: string | null;
  readonly status: string | null;
  readonly summary: string | null;
  readonly timestamp: string | null;
  readonly loggedBy: string | null;
  readonly sfRecordId: string | null;
  // Provenance flag — the SPA can render a "limited timeline" badge while the
  // PE-rollup-only sourcing is in place. Removed when the full E-09 timeline
  // lands (or IDW_Case_Note__c gains a PE link, whichever comes first).
  readonly provenance: "pe_rollup";
}

export type QuickActionState = "enabled" | "disabled";

export type QuickActionDisabledReason =
  | "supervisor_read_only"
  | "no_phone_on_file"
  | "no_email_on_file"
  | "consent_unknown";

export interface QuickActions {
  readonly logCall: QuickActionState;
  readonly logCallDisabledReason?: QuickActionDisabledReason;
  readonly sendSms: QuickActionState;
  readonly sendSmsDisabledReason?: QuickActionDisabledReason;
  readonly sendEmail: QuickActionState;
  readonly sendEmailDisabledReason?: QuickActionDisabledReason;
  readonly scheduleVisit: QuickActionState;
  readonly scheduleVisitDisabledReason?: QuickActionDisabledReason;
}

// The full §7.4.1 response envelope.
export interface ParticipantDetailBody {
  readonly participantId: string;
  readonly displayName: string | null;
  readonly enrollmentCode: string | null;
  readonly aftercareStartDate: string | null;
  readonly aftercareDay: number | null;
  readonly programStatus: string;
  readonly outcome: string | null;
  readonly preferredContactMethod: PreferredContactMethod;
  readonly communicationConsent: CommunicationConsent;
  readonly contact: ParticipantContact;
  readonly currentTier: number | null;
  readonly currentPriorityScore: number | null;
  readonly priorityModifier: string | null;
  readonly highestImpactFactor: CaseloadHighestImpactFactor | null;
  readonly factors: ReadonlyArray<CaseloadFactor>;
  readonly triggered_invariants: ReadonlyArray<CaseloadTriggeredInvariant>;
  readonly stabilityVisit: CaseloadStabilityVisit;
  readonly cycleStatus: CaseloadCycleStatus;
  readonly perCheckpointBreakdown: ReadonlyArray<PerCheckpointBreakdownDto>;
  readonly openBarriers: ReadonlyArray<CaseloadOpenBarrier>;
  readonly tags: ReadonlyArray<RowTag>;
  readonly recentContacts: ReadonlyArray<ParticipantRecentContact>;
  readonly quickActions: QuickActions;
  readonly dataIssues: ReadonlyArray<string>;
}

export interface BuildParticipantDetailBodyInput {
  readonly identity: ParticipantIdentity;
  readonly snapshot: CaseloadSnapshot | null;
  readonly engine: EngineOutput | null;
  readonly configuration: Configuration;
  readonly role: Role;
  readonly now: Date;
}

// Assembles the §7.4.1 wire body. `snapshot === null` reflects a degraded read
// (the scoring kernel could not find the row, e.g. the owner changed mid-flight
// or the engine threw on this participant). In that case the engine-driven
// blocks fall back to safe defaults and `dataIssues` carries `score_unresolved`
// — the detail view still renders so the specialist can act on the basics.
export function buildParticipantDetailBody(
  input: BuildParticipantDetailBodyInput,
): ParticipantDetailBody {
  const { identity, snapshot, engine, configuration, role, now } = input;

  const stabilityVisit = snapshot
    ? buildStabilityVisit(snapshot.enrollment, configuration, now)
    : EMPTY_STABILITY_VISIT;
  const cycleStatus = snapshot
    ? buildCycleStatus(snapshot.enrollment, now)
    : EMPTY_CYCLE_STATUS;
  const perCheckpointBreakdown = snapshot
    ? buildPerCheckpointBreakdown(snapshot.enrollment, now)
    : [];
  const openBarriers = snapshot
    ? buildOpenBarriers(snapshot.barriers, configuration, now)
    : [];
  // P1H-03 — same chip cluster as the caseload row (`buildCaseloadItem`).
  // `snapshot === null` is the F-07 degraded read (parallel to the caseload
  // `degraded` path); emit `[]` so the detail page never displays signals
  // we can't back up with a source row.
  const voucherRecertDays = snapshot?.enrollment.voucherRecertDeadline
    ? wholeDaysBetween(now, snapshot.enrollment.voucherRecertDeadline)
    : null;
  const tags: ReadonlyArray<RowTag> = snapshot
    ? deriveRowTags(
        buildRowTagSnapshot({
          enrollment: snapshot.enrollment,
          snapshot,
          perCheckpointBreakdown,
          voucherRecertDays,
          configuration,
        }),
        now,
      )
    : [];

  const dataIssues: string[] = [];
  if (snapshot === null) dataIssues.push("score_unresolved");
  if (identity.aftercareStartDate === null) {
    dataIssues.push("missing_aftercare_start_date");
  }

  return {
    participantId: identity.participantId,
    displayName: identity.displayName,
    enrollmentCode: identity.enrollmentCode,
    aftercareStartDate:
      identity.aftercareStartDate === null
        ? null
        : toIsoDate(identity.aftercareStartDate),
    aftercareDay:
      identity.aftercareStartDate === null
        ? null
        : wholeDaysBetween(identity.aftercareStartDate, now),
    // `programStatus` is "Aftercare" by construction — the caseload hydration
    // bounds rows to RecordType='Matching' AND Inactive__c=false AND
    // Date_of_Withdrawal_or_Graduation__c=null (per bulk-hydration.ts), and a
    // PE that does not satisfy that bound would not be reachable as a detail-
    // view target in normal flow. Surface it on the wire so the SPA does not
    // have to compute it client-side.
    programStatus: "Aftercare",
    outcome: identity.programEnrollmentOutcome,
    preferredContactMethod: null,
    communicationConsent: STUB_CONSENT,
    contact: {
      phone: identity.phone,
      phoneRevealable: false,
      email: identity.email,
      address: EMPTY_ADDRESS,
    },
    currentTier: engine?.tier ?? null,
    currentPriorityScore: engine?.priorityScore ?? null,
    priorityModifier: engine?.priorityModifier ?? null,
    highestImpactFactor:
      engine === null ? null : adaptHighestImpact(engine.highestImpactFactor),
    factors: engine === null ? [] : engine.factors.map(adaptFactor),
    triggered_invariants:
      engine === null ? [] : engine.triggeredInvariants.map(adaptInvariant),
    stabilityVisit,
    cycleStatus,
    perCheckpointBreakdown,
    openBarriers,
    tags,
    recentContacts: buildRecentContactsFromIdentity(identity),
    quickActions: buildQuickActions({
      role,
      hasPhone: identity.phone !== null,
      hasEmail: identity.email !== null,
    }),
    dataIssues,
  };
}

// Synthesizes the §7.4.1 `recentContacts[]` block from the PE rollup fields.
// **Schema-gap note** (flagged in PR body / new TBD-v1.3-5): the canonical
// E-08 spec assumes a paginated top-N timeline sourced from `IDW_Case_Note__c`,
// but P0-08d confirmed that object has NO PE link, no service date, and no
// contact_type field. The only path available today is the PE rollup
// (`Most_Recent_Case_Note_*`), which yields at most one entry. `provenance:
// "pe_rollup"` lets the SPA render an honest "limited timeline" affordance
// until E-09 or a schema fix lands.
export function buildRecentContactsFromIdentity(
  identity: ParticipantIdentity,
): ReadonlyArray<ParticipantRecentContact> {
  const note = identity.mostRecentCaseNote;
  // An empty rollup (no case notes for this PE at all) yields an empty array —
  // not a synthesized "unknown" row. The SPA already handles the empty state.
  if (
    note.date === null &&
    note.status === null &&
    note.type === null &&
    note.summary === null
  ) {
    return [];
  }
  return [
    {
      contactId: null,
      type: "case_note",
      caseNoteType: note.type,
      // `contactType` cannot be sourced from the rollup — the underlying
      // `Contact_Type__c` does not exist on `IDW_Case_Note__c` (P0-08d).
      contactType: null,
      // Legacy v1.0–v1.2 `channel` field is null for the same reason. The
      // §7.4.1 docs note both `channel` (deprecated-soft) and `contactType`
      // are nullable.
      channel: null,
      status: note.status,
      summary: note.summary,
      timestamp: note.date === null ? null : note.date.toISOString(),
      // `loggedBy` (Salesforce User Id or display name) is not on the rollup
      // — the rollup only carries text + date + status + type. Null.
      loggedBy: null,
      // The rollup does not surface the source Case Note Id. The SPA cannot
      // deep-link to it from this payload; E-09 is the deep-link source.
      sfRecordId: null,
      provenance: "pe_rollup",
    },
  ];
}

export interface BuildQuickActionsInput {
  readonly role: Role;
  readonly hasPhone: boolean;
  readonly hasEmail: boolean;
}

// Server-computed quick-action availability for SPA tooltip text (FS-17).
// SUPERVISOR is "read-only" on the detail view per F-07 AC-29 — every action
// disables with the same reason so the SPA can render one banner instead of
// four tooltips. SPECIALIST + VP get the live phone/email + consent gating.
// SYSTEM_ADMIN is denied at the endpoint layer (403); these values are unused
// in that path but defaulted to fully-disabled here for shape stability.
export function buildQuickActions(input: BuildQuickActionsInput): QuickActions {
  const isReadOnly = input.role === "SUPERVISOR";
  if (isReadOnly || input.role === "SYSTEM_ADMIN") {
    return {
      logCall: "disabled",
      logCallDisabledReason: "supervisor_read_only",
      sendSms: "disabled",
      sendSmsDisabledReason: "supervisor_read_only",
      sendEmail: "disabled",
      sendEmailDisabledReason: "supervisor_read_only",
      scheduleVisit: "disabled",
      scheduleVisitDisabledReason: "supervisor_read_only",
    };
  }

  // SPECIALIST / VP path. `sendSms` is gated on phone-on-file + consent —
  // consent is unknown today (stub posture in `STUB_CONSENT`), so the SPA gets
  // `consent_unknown` whenever a phone exists. When the consent source lands,
  // this branch flips to honor the explicit flag.
  const smsState: { state: QuickActionState; reason?: QuickActionDisabledReason } =
    !input.hasPhone
      ? { state: "disabled", reason: "no_phone_on_file" }
      : { state: "disabled", reason: "consent_unknown" };
  const emailState: { state: QuickActionState; reason?: QuickActionDisabledReason } =
    input.hasEmail
      ? { state: "enabled" }
      : { state: "disabled", reason: "no_email_on_file" };

  return {
    logCall: "enabled",
    sendSms: smsState.state,
    ...(smsState.reason !== undefined
      ? { sendSmsDisabledReason: smsState.reason }
      : {}),
    sendEmail: emailState.state,
    ...(emailState.reason !== undefined
      ? { sendEmailDisabledReason: emailState.reason }
      : {}),
    scheduleVisit: "enabled",
  };
}

// Stable singletons for the degraded path — avoid allocating a new empty
// object on every request.
const EMPTY_ADDRESS: ParticipantAddress = {
  street: null,
  city: null,
  state: null,
  zip: null,
};

const STUB_CONSENT: CommunicationConsent = {
  sms: null,
  email: null,
  smsConsentVerifiedAt: null,
};

const EMPTY_STABILITY_VISIT: CaseloadStabilityVisit = {
  status: "on_track",
  statusLabel: "On track",
  nextDueDate: null,
  checkpoint: null,
  completedCount: null,
  missedCount: null,
  scheduledVisitDateTime: null,
};

const EMPTY_CYCLE_STATUS: CaseloadCycleStatus = {
  state: "due",
  daysToNext: null,
  daysOverdue: 0,
  nextCheckpoint: null,
  lastCreditedCheckpoint: null,
};
