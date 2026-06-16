import type {
  CaseloadOpenBarrier,
  ParticipantDetailBody,
  PriorityRecomputed,
} from "@anthos/api";
import { describe, expect, it } from "vitest";

import {
  applyOptimisticClose,
  applyOptimisticCreate,
  applyPriorityRecompute,
  replaceTempBarrier,
  rollbackToSnapshot,
  snapshotDetailBody,
} from "../../app/participants/[id]/_lib/participant-barrier-mutations";

const P1 = "a015g00000ABCDxQAO";
const P2 = "a015g00000XYZyQAO";

function makeBody(
  overrides: Partial<ParticipantDetailBody> = {},
): ParticipantDetailBody {
  const base: ParticipantDetailBody = {
    participantId: P1,
    displayName: null,
    enrollmentCode: null,
    aftercareStartDate: null,
    aftercareDay: 100,
    programStatus: "Active",
    outcome: null,
    preferredContactMethod: null,
    communicationConsent: {
      sms: null,
      email: null,
      smsConsentVerifiedAt: null,
    },
    contact: {
      phone: null,
      phoneRevealable: false,
      email: null,
      address: { street: null, city: null, state: null, zip: null },
    },
    currentTier: 2,
    currentPriorityScore: 42.5,
    priorityModifier: "stale",
    highestImpactFactor: {
      key: "days_since_last_contact",
      name: "Days since last successful contact",
      valueLabel: "8 days",
      weight: "×1.5",
      pointsContributed: 12,
    },
    factors: [
      {
        key: "days_since_last_contact",
        name: "Days since last successful contact",
        valueLabel: "8 days",
        valueNumeric: 8,
        weight: "×1.5",
        pointsContributed: 12,
      },
    ],
    triggered_invariants: [
      { invariant_id: "stale_check_in", display_label: "No check-in in 14 days" },
    ],
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
      state: "between",
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
      sendSmsDisabledReason: "no_phone_on_file",
      sendEmail: "disabled",
      sendEmailDisabledReason: "no_email_on_file",
      scheduleVisit: "enabled",
    },
    dataIssues: [],
  };
  return { ...base, ...overrides };
}

// ── snapshotDetailBody ─────────────────────────────────────────────────────

describe("snapshotDetailBody", () => {
  it("captures the mutable slice (priority + barriers) byte-for-byte", () => {
    const body = makeBody({
      openBarriers: [
        {
          barrierId: "b1",
          type: "Domestic Violence",
          severity: "high",
          openedAt: "2026-05-20T00:00:00Z",
          ageDays: 4,
        },
      ],
    });
    const snap = snapshotDetailBody(body);
    expect(snap.currentTier).toBe(2);
    expect(snap.currentPriorityScore).toBe(42.5);
    expect(snap.factors).toBe(body.factors);
    expect(snap.openBarriers).toBe(body.openBarriers);
  });
});

// ── applyOptimisticCreate ──────────────────────────────────────────────────

describe("applyOptimisticCreate", () => {
  it("appends an optimistic Barrier with the supplied temp id", () => {
    const body = makeBody();
    const next = applyOptimisticCreate(body, {
      tempBarrierId: "optimistic:abc",
      type: "Domestic Violence",
      severity: null,
      openedAtIso: "2026-05-23T12:00:00Z",
    });
    expect(next.openBarriers).toHaveLength(1);
    expect(next.openBarriers[0]).toEqual({
      barrierId: "optimistic:abc",
      type: "Domestic Violence",
      severity: null,
      openedAt: "2026-05-23T12:00:00Z",
      ageDays: 0,
    });
  });

  it("does not mutate the source body", () => {
    const body = makeBody();
    applyOptimisticCreate(body, {
      tempBarrierId: "optimistic:abc",
      type: "Domestic Violence",
      severity: null,
      openedAtIso: "2026-05-23T12:00:00Z",
    });
    expect(body.openBarriers).toHaveLength(0);
  });
});

// ── applyOptimisticClose ───────────────────────────────────────────────────

describe("applyOptimisticClose", () => {
  it("removes the matching Barrier from openBarriers", () => {
    const body = makeBody({
      openBarriers: [
        {
          barrierId: "b1",
          type: "DV",
          severity: "high",
          openedAt: "x",
          ageDays: 1,
        },
        {
          barrierId: "b2",
          type: "Repair",
          severity: "low",
          openedAt: "x",
          ageDays: 1,
        },
      ],
    });
    const next = applyOptimisticClose(body, "b1");
    expect(next.openBarriers).toHaveLength(1);
    expect(next.openBarriers[0]?.barrierId).toBe("b2");
  });

  it("is a no-op when the barrierId is not present", () => {
    const body = makeBody({
      openBarriers: [
        {
          barrierId: "b1",
          type: "DV",
          severity: "high",
          openedAt: "x",
          ageDays: 1,
        },
      ],
    });
    const next = applyOptimisticClose(body, "missing");
    expect(next.openBarriers).toHaveLength(1);
  });
});

// ── replaceTempBarrier ─────────────────────────────────────────────────────

describe("replaceTempBarrier", () => {
  it("swaps the temp Barrier with the canonical one", () => {
    const body = makeBody({
      openBarriers: [
        {
          barrierId: "optimistic:abc",
          type: "DV",
          severity: null,
          openedAt: "x",
          ageDays: 0,
        },
      ],
    });
    const canonical: CaseloadOpenBarrier = {
      barrierId: "a065g00000QQQ",
      type: "Domestic Violence",
      severity: "high",
      openedAt: "2026-05-23T12:00:00Z",
      ageDays: 0,
    };
    const next = replaceTempBarrier(body, "optimistic:abc", canonical);
    expect(next.openBarriers[0]).toEqual(canonical);
  });
});

// ── applyPriorityRecompute ─────────────────────────────────────────────────

describe("applyPriorityRecompute", () => {
  it("updates currentTier, currentPriorityScore, and factors", () => {
    const body = makeBody({ currentTier: 3, currentPriorityScore: 10 });
    const recompute: PriorityRecomputed = {
      participantId: P1,
      score: 88.0,
      tier: 1,
      previousScore: 10,
      previousTier: 3,
      factors: [
        {
          key: "new_factor",
          name: "New factor",
          valueLabel: "5",
          valueNumeric: 5,
          weight: "×2",
          pointsContributed: 10,
        },
      ],
    };
    const next = applyPriorityRecompute(body, recompute);
    expect(next.currentTier).toBe(1);
    expect(next.currentPriorityScore).toBe(88.0);
    expect(next.factors).toHaveLength(1);
    expect(next.factors[0]?.name).toBe("New factor");
  });

  it("preserves priorityModifier, highestImpactFactor, and triggered_invariants", () => {
    const body = makeBody();
    const recompute: PriorityRecomputed = {
      participantId: P1,
      score: 50,
      tier: 2,
      previousScore: 42.5,
      previousTier: 2,
      factors: [],
    };
    const next = applyPriorityRecompute(body, recompute);
    expect(next.priorityModifier).toBe(body.priorityModifier);
    expect(next.highestImpactFactor).toBe(body.highestImpactFactor);
    expect(next.triggered_invariants).toBe(body.triggered_invariants);
  });

  it("is a no-op when the recompute is for a different participant", () => {
    const body = makeBody({ currentTier: 2 });
    const recompute: PriorityRecomputed = {
      participantId: P2,
      score: 100,
      tier: 1,
      previousScore: 42.5,
      previousTier: 2,
      factors: [],
    };
    expect(applyPriorityRecompute(body, recompute)).toBe(body);
  });
});

// ── rollbackToSnapshot ─────────────────────────────────────────────────────

describe("rollbackToSnapshot", () => {
  it("restores currentTier, currentPriorityScore, factors, and openBarriers", () => {
    const original = makeBody({
      currentTier: 2,
      currentPriorityScore: 42.5,
      openBarriers: [
        {
          barrierId: "b1",
          type: "DV",
          severity: "high",
          openedAt: "x",
          ageDays: 0,
        },
      ],
    });
    const snap = snapshotDetailBody(original);
    const mutated = applyOptimisticClose(
      applyPriorityRecompute(original, {
        participantId: P1,
        score: 0,
        tier: 3,
        previousScore: 42.5,
        previousTier: 2,
        factors: [],
      }),
      "b1",
    );
    const restored = rollbackToSnapshot(mutated, snap);
    expect(restored.currentTier).toBe(2);
    expect(restored.currentPriorityScore).toBe(42.5);
    expect(restored.openBarriers).toBe(snap.openBarriers);
  });
});
