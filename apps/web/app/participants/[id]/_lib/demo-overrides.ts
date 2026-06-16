// ⚠️ DEMO ONLY — REMOVE AFTER THE 2026-06-15 DEMO ⚠️
//
// Frontend-only dummy data for a single participant (Doris Simmons) so the
// detail-view cards that are otherwise stubbed — Demographics, Voucher &
// subsidy, and the address/consent/preferred-channel rows of Contact
// preferences — render populated values while telling the demo story.
//
// This touches NO Salesforce data and NO API/DTO/hydration code: it simply
// supplies card props for one hard-coded participant id. Every other
// participant is unaffected (`getDemoOverride` returns `undefined`), so their
// cards keep their honest stub state.
//
// Reversal: delete this file and revert the prop wiring in
// `ParticipantDetailView.tsx`.

import type {
  CommunicationConsent,
  ParticipantAddress,
  PreferredContactMethod,
} from "@anthos/api";

import type { DemographicsContext } from "../_components/DemographicsContextCard";
import type { VoucherSubsidy } from "../_components/VoucherSubsidyCard";

export interface ParticipantDemoOverride {
  readonly demographics: DemographicsContext;
  readonly voucher: VoucherSubsidy;
  readonly preferredContactMethod: PreferredContactMethod;
  readonly communicationConsent: CommunicationConsent;
  readonly address: ParticipantAddress;
}

// Keyed by Program Enrollment id. Doris Simmons — the demo participant. A Map
// (not a plain object) so lookups aren't a prototype-pollution / object-
// injection sink on the untrusted `participantId`.
const DEMO_OVERRIDES: ReadonlyMap<string, ParticipantDemoOverride> = new Map([
  [
    "a1kU800000pjn67IAA",
    {
      demographics: {
        age: 47,
        languagePreference: "English",
        householdSummary: "Household of 2",
        disabilityAccommodations: "None recorded",
      },
      voucher: {
        type: "CityFHEPS",
        recertDueDate: "Jul 18, 2026",
        daysUntilRecert: 40,
      },
      preferredContactMethod: "text",
      communicationConsent: {
        sms: true,
        email: true,
        smsConsentVerifiedAt: null,
      },
      address: {
        street: "210 Joralemon St",
        city: "Brooklyn",
        state: "NY",
        zip: "11201",
      },
    },
  ],
]);

// Returns the demo dummy-data override for a participant, or `undefined` when
// the participant is not part of the demo dressing (the common case).
export function getDemoOverride(
  participantId: string,
): ParticipantDemoOverride | undefined {
  return DEMO_OVERRIDES.get(participantId);
}
