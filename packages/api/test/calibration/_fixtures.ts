import type { CaseloadSnapshot } from "@anthos/integrations";

// Shared CaseloadSnapshot builders for the calibration test suite. The
// defaults are all-null / empty so each projected factor degrades to its
// documented default; pass `overrides` to light up a specific factor.

type Enrollment = CaseloadSnapshot["enrollment"];
type Barrier = CaseloadSnapshot["barriers"][number];
type Incident = CaseloadSnapshot["incidents"][number];
type Arrear = CaseloadSnapshot["arrears"][number];
type Repair = CaseloadSnapshot["repairs"][number];

export interface SnapshotOverrides {
  readonly hydratedAt?: Date;
  readonly enrollment?: Partial<Enrollment>;
  readonly barriers?: ReadonlyArray<Barrier>;
  readonly incidents?: ReadonlyArray<Incident>;
  readonly arrears?: ReadonlyArray<Arrear>;
  readonly repairs?: ReadonlyArray<Repair>;
}

const DEFAULT_HYDRATED_AT = new Date("2026-05-18T12:00:00Z");

export function makeSnapshot(
  participantId: string,
  ownerId: string,
  overrides: SnapshotOverrides = {},
): CaseloadSnapshot {
  return {
    participantId,
    ownerId,
    hydratedAt: overrides.hydratedAt ?? DEFAULT_HYDRATED_AT,
    enrollment: {
      aftercareOwnerId: ownerId,
      peName: null,
      displayName: null,
      programCode: null,
      mostRecentSuccessfulContact: null,
      aftercareStartDate: null,
      aftercareEndDate: null,
      aftercareExtensionEndDate: null,
      aftercareExtended: false,
      dueDates: {
        first: null,
        second: null,
        third: null,
        fourth: null,
        upcoming: null,
      },
      programEnrollmentOutcome: null,
      contactId: null,
      accountId: null,
      voucherRecertDeadline: null,
      checkInsAttempted: null,
      checkInsCompleted: null,
      missedCheckIns: null,
      ...overrides.enrollment,
    },
    barriers: overrides.barriers ?? [],
    incidents: overrides.incidents ?? [],
    arrears: overrides.arrears ?? [],
    repairs: overrides.repairs ?? [],
  };
}

// A full AftercareDueDates carrying only the `upcoming` checkpoint date —
// the one field the BR-19(b) stability-visit derivation reads.
export function dueDatesWith(upcoming: Date | null): Enrollment["dueDates"] {
  return { first: null, second: null, third: null, fourth: null, upcoming };
}

export function makeBarrier(overrides: Partial<Barrier> = {}): Barrier {
  return {
    id: "barrier-1",
    type: null,
    status: null,
    stage: null,
    startDate: null,
    endDate: null,
    daysSinceLastUpdate: null,
    ...overrides,
  };
}

export function makeIncident(overrides: Partial<Incident> = {}): Incident {
  return {
    id: "incident-1",
    incidentType: null,
    status: null,
    incidentDate: null,
    critical: false,
    ...overrides,
  };
}

export function makeArrear(overrides: Partial<Arrear> = {}): Arrear {
  return {
    id: "arrear-1",
    programEnrollmentId: null,
    unitEngagementId: null,
    status: null,
    dateIdentified: null,
    dateResolved: null,
    arrearsStartDate: null,
    arrearsEndDate: null,
    purpose: null,
    estimatedAmount: null,
    amountPaid: null,
    lengthOfTimeMonths: null,
    ...overrides,
  };
}
