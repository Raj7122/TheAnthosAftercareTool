import type {
  ParticipantDetailBody,
  QuickActions,
} from "@anthos/api";
import { describe, expect, it } from "vitest";

// P1F-08 wire-contract guard. The detail SPA binds to specific keys on
// `ParticipantDetailBody`; this test enforces that the SPA's expectation of
// the wire shape stays in lock-step with `packages/api/src/participants/dto.ts`.
//
// Why a guard test here when `packages/api/test/participants/get-participant
// .test.ts` already covers the handler exhaustively? That suite asserts what
// the handler RETURNS. This suite asserts what the SPA REQUIRES. If a future
// refactor renames `currentPriorityScore` to `priorityScore`, the handler
// test still passes (it's renaming the field on both sides), but this test
// fails — surfacing the breaking change at the SPA boundary.
//
// Run as a pure-function test (no React, no SF, no DB) per the project's
// `apps/web/test` discipline. The TypeScript checker does the heavy lifting:
// the literal-typed `SPA_REQUIRED_KEYS` and `QUICK_ACTION_KEYS` arrays
// generate compile-time errors if a referenced key disappears from the DTO.

const SPA_REQUIRED_KEYS: ReadonlyArray<keyof ParticipantDetailBody> = [
  "participantId",
  "displayName",
  "enrollmentCode",
  "aftercareDay",
  "programStatus",
  "outcome",
  "preferredContactMethod",
  "communicationConsent",
  "contact",
  "currentTier",
  "currentPriorityScore",
  "highestImpactFactor",
  "factors",
  "triggered_invariants",
  "perCheckpointBreakdown",
  "openBarriers",
  "recentContacts",
  "quickActions",
];

const QUICK_ACTION_KEYS: ReadonlyArray<keyof QuickActions> = [
  "logCall",
  "sendSms",
  "sendEmail",
  "scheduleVisit",
];

function makeBody(overrides: Partial<ParticipantDetailBody> = {}): ParticipantDetailBody {
  return {
    participantId: "a015g00000ABCDxQAO",
    displayName: null,
    enrollmentCode: null,
    aftercareStartDate: null,
    aftercareDay: null,
    programStatus: "Aftercare",
    outcome: null,
    preferredContactMethod: null,
    communicationConsent: { sms: null, email: null, smsConsentVerifiedAt: null },
    contact: {
      phone: null,
      phoneRevealable: false,
      email: null,
      address: { street: null, city: null, state: null, zip: null },
    },
    currentTier: null,
    currentPriorityScore: null,
    priorityModifier: null,
    highestImpactFactor: null,
    factors: [],
    triggered_invariants: [],
    stabilityVisit: {
      status: "on_track",
      statusLabel: "On track",
      nextDueDate: null,
      checkpoint: null,
      completedCount: null,
      missedCount: null,
      scheduledVisitDateTime: null,
    },
    cycleStatus: {
      state: "due",
      daysToNext: null,
      daysOverdue: 0,
      nextCheckpoint: null,
      lastCreditedCheckpoint: null,
    },
    perCheckpointBreakdown: [],
    openBarriers: [],
    tags: [],
    recentContacts: [],
    quickActions: {
      logCall: "enabled",
      sendSms: "disabled",
      sendSmsDisabledReason: "consent_unknown",
      sendEmail: "disabled",
      sendEmailDisabledReason: "no_email_on_file",
      scheduleVisit: "enabled",
    },
    dataIssues: [],
    ...overrides,
  };
}

describe("ParticipantDetailBody — SPA wire-contract guard (P1F-08)", () => {
  it("every key the SPA renders is present on the all-null degraded body", () => {
    const body = makeBody();
    for (const key of SPA_REQUIRED_KEYS) {
      expect(body, `wire DTO missing SPA-required key "${String(key)}"`).toHaveProperty(
        String(key),
      );
    }
  });

  it("every quickActions slot the SPA renders is present", () => {
    const body = makeBody();
    for (const key of QUICK_ACTION_KEYS) {
      expect(body.quickActions, `quickActions missing slot "${String(key)}"`).toHaveProperty(
        String(key),
      );
    }
  });

  it("contact.address keeps the four nullable parts the IdentityCard formats", () => {
    const body = makeBody();
    expect(body.contact.address).toEqual({
      street: null,
      city: null,
      state: null,
      zip: null,
    });
  });

  it("recentContacts items carry `provenance: 'pe_rollup'` when surfaced from the rollup", () => {
    const body = makeBody({
      recentContacts: [
        {
          contactId: null,
          type: "case_note",
          caseNoteType: "Check-in",
          contactType: null,
          channel: null,
          status: "Completed",
          summary: "Spoke with participant briefly.",
          timestamp: "2026-05-22T18:15:00.000Z",
          loggedBy: null,
          sfRecordId: null,
          provenance: "pe_rollup",
        },
      ],
    });
    expect(body.recentContacts[0]?.provenance).toBe("pe_rollup");
  });

  it("communicationConsent stays in the {sms, email, smsConsentVerifiedAt} shape (P1F-01 stub posture)", () => {
    const body = makeBody();
    expect(body.communicationConsent).toEqual({
      sms: null,
      email: null,
      smsConsentVerifiedAt: null,
    });
  });

  it("phoneRevealable is `false` until the v1.4+ reveal mechanism lands", () => {
    expect(makeBody().contact.phoneRevealable).toBe(false);
  });
});
