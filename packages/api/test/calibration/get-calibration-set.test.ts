import { describe, expect, it, vi } from "vitest";

import {
  createFailedAttemptsInvariant,
  getActiveFactors,
  getCalibrationConfiguration,
  type Configuration,
  type Factor,
  type HydratedParticipant,
  type TierInvariant,
} from "@anthos/domain";
import type { CaseloadSnapshot } from "@anthos/integrations";

import { getCalibrationSet } from "../../src/calibration/get-calibration-set.js";
import {
  dueDatesWith,
  makeArrear,
  makeBarrier,
  makeIncident,
  makeSnapshot,
} from "./_fixtures.js";

const MS_PER_DAY = 86_400_000;

function makeFactor(key: string, valueNumeric: number): Factor {
  return {
    key,
    displayName: key,
    type: "numeric",
    compute(): { valueLabel: string; valueNumeric: number } {
      return { valueLabel: `${valueNumeric}`, valueNumeric };
    },
  };
}

function makeConfig(weights: Record<string, number>): Configuration {
  return {
    version: 1,
    isActive: true,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    createdBy: "test",
    activationAt: new Date("2026-01-01T00:00:00Z"),
    deactivatedAt: null,
    factorWeights: {
      additive: weights,
      multiplicative_modifiers: {},
      overlap_caps: [],
    },
    tierThresholds: { tier1_min: 80, tier2_min: 50 },
    queuePredicates: {},
    barrierSeverityClassification: {},
    barrierSeverityHigh: "3.00",
    barrierSeverityMedium: "2.00",
    barrierSeverityLow: "1.00",
    barrierStalenessMultiplier: "1.50",
    barrierStalenessThresholdDays: 30,
    tierInvariants: {
      failed_attempts_tier1_threshold: 999,
      barrier_type_to_invariant: {},
      open_repair_invariant: null,
      invariant_override_suppression: true,
    },
    dueStatusLeadTimeDays: 14,
    voucherRecertWarningDays: 30,
    recentIncidentWindowDays: 30,
    failedAttemptResetOnCompleted: true,
    recalibrationCadenceDays: 90,
    calibrationAlpha: "1.00",
    calibrationBeta: "2.00",
    calibrationThresholdPct: "85.00",
    calibrationParticipantsFloor: 10,
    sbopPath: "A",
    sbopSuppressionDays: 14,
    sbopEnabled: false,
    capacityStrainMultiplier: "1.6",
    capacityStrainPersistenceDays: 4,
    quietHoursStartLocal: "21:00:00",
    quietHoursEndLocal: "08:00:00",
    mogliTimeoutSeconds: 5,
    mogliBackoffSeconds: [5],
    offlineMaxQueueDepth: 100,
    offlineMaxRetries: 5,
    idempotencyTtlHours: 24,
    hardRefreshRateLimitSeconds: 30,
    nightlyRefreshCron: "0 2 * * *",
    weeklyDigestCron: "0 8 * * MON",
    dailyDigestCron: "0 8 * * *",
    tieBreakerStrategy: "oldest_contact_then_id",
    featureFlags: {},
    approvalMetadata: null,
    notes: null,
  };
}

describe("getCalibrationSet", () => {
  it("returns degraded DTOs when factor registry is empty", async () => {
    const ownerIds = ["005A", "005B"];
    const result = await getCalibrationSet({
      ownerIds,
      factors: [],
      invariants: [],
      configuration: makeConfig({}),
      hydrate: async (ownerId) => ({
        snapshots: [makeSnapshot(`P-${ownerId}-1`, ownerId)],
      }),
    });

    expect(result).toHaveLength(2);
    expect(result[0]?.scored).toBe(false);
    expect(result[0]?.priorityScore).toBeNull();
    expect(result[0]?.tier).toBeNull();
    expect(result[0]?.factors).toEqual([]);
    expect(result[0]?.triggeredInvariants).toEqual([]);
    expect(result[1]?.participantId).toBe("P-005B-1");
  });

  it("returns scored DTOs when factors are populated", async () => {
    const factors = [makeFactor("days_since_last_contact", 60)];
    const result = await getCalibrationSet({
      ownerIds: ["005A"],
      factors,
      invariants: [],
      configuration: makeConfig({ days_since_last_contact: 1.5 }),
      hydrate: async (ownerId) => ({
        snapshots: [makeSnapshot("P-1", ownerId)],
      }),
    });

    expect(result).toHaveLength(1);
    const dto = result[0];
    expect(dto?.scored).toBe(true);
    expect(dto?.priorityScore).toBeCloseTo(90, 5);
    expect(dto?.tier).toBe(1);
    expect(dto?.factors).toHaveLength(1);
    expect(dto?.factors[0]?.key).toBe("days_since_last_contact");
    expect(dto?.highestImpactFactor?.key).toBe("days_since_last_contact");
  });

  it("preserves participantId, ownerId, hydratedAt from each snapshot", async () => {
    const hydratedAt = new Date("2026-04-01T10:00:00Z");
    const snap: CaseloadSnapshot = {
      ...makeSnapshot("P-XYZ", "005X"),
      hydratedAt,
    };
    const result = await getCalibrationSet({
      ownerIds: ["005X"],
      factors: [],
      invariants: [],
      configuration: makeConfig({}),
      hydrate: async () => ({ snapshots: [snap] }),
    });

    expect(result[0]?.participantId).toBe("P-XYZ");
    expect(result[0]?.ownerId).toBe("005X");
    expect(result[0]?.hydratedAt).toEqual(hydratedAt);
  });

  it("returns an empty array when no owner ids are configured", async () => {
    const result = await getCalibrationSet({
      ownerIds: [],
      factors: [],
      invariants: [],
      configuration: makeConfig({}),
      hydrate: async () => ({ snapshots: [] }),
    });
    expect(result).toEqual([]);
  });

  // NEW (v1.2) — TRD v1.8 §1787 / TR-PRIORITY-7 v1.2: verify the API DTO
  // exposes `triggered_invariants[]` with snake_case wire keys
  // `{invariant_id, display_label, triggering_record_id?}` and preserves
  // input order under multi-fire. `triggering_record_id` is OPTIONAL — BR-24
  // is an aggregate invariant with no single record; the record-bearing
  // invariants (BR-25 open-repair, BR-26 habitability) carry the triggering
  // record id for UI deep-linking.
  //
  // Scope of this test: the `adaptInvariant()` snake_case wire boundary in
  // `dto.ts`, exercised end-to-end through `scoredDto()`. The synthetic
  // record-bearing invariant reads off `participant.snapshot` directly
  // because `snapshotToHydratedParticipant` in get-calibration-set.ts does
  // NOT yet project the snapshot's sibling collections onto the per-factor
  // participant fields. The real BR-25 invariant (`createOpenRepairInvariant`,
  // P0-04e) reads `participant.repairs` and will silently NOT fire end-to-end
  // through the orchestrator until the P0-04 hydration step adds that mapping.
  // The synthetic invariant here verifies the adapter's wire-key contract
  // under multi-fire; verifying BR-25 end-to-end is a P0-04 concern.
  it("scored DTOs surface triggered_invariants[] in snake_case wire shape with multiple invariants firing in input order (TR-PRIORITY-7 v1.2)", async () => {
    const factors = [makeFactor("failed_attempts", 4)];
    const snapshot: CaseloadSnapshot = {
      ...makeSnapshot("P-1", "005A"),
      repairs: [
        {
          id: "a5RU8000000RP1IAQ",
          // The minimum RepairSnapshot shape the synthetic invariant reads;
          // cast through unknown to dodge the strict CaseloadSnapshot.repairs
          // element type — irrelevant to what's under test.
        } as unknown as CaseloadSnapshot["repairs"][number],
      ],
    };
    const openRepairInvariant: TierInvariant = {
      id: "BR-25",
      check(participant: HydratedParticipant) {
        const snap = participant["snapshot"] as CaseloadSnapshot | undefined;
        const match = snap?.repairs?.[0];
        return match
          ? {
              triggered: true,
              label: "Open Repair",
              floorTier: 1,
              triggeringRecordId: (match as { id: string }).id,
            }
          : { triggered: false, label: "Open Repair", floorTier: 1 };
      },
    };

    const result = await getCalibrationSet({
      ownerIds: ["005A"],
      factors,
      // Ordering matters: triggeredInvariants preserves invariants input order
      // per apply-tier-floors.ts. Reverse this array and the assertion below
      // would flip.
      invariants: [
        createFailedAttemptsInvariant({ threshold: 3 }),
        openRepairInvariant,
      ],
      configuration: makeConfig({ failed_attempts: 1.5 }),
      hydrate: async () => ({ snapshots: [snapshot] }),
    });

    expect(result).toHaveLength(1);
    const dto = result[0];
    expect(dto?.scored).toBe(true);
    expect(dto?.triggeredInvariants).toHaveLength(2);
    // Aggregate BR-24 — `triggering_record_id` omitted entirely (not null).
    expect(dto?.triggeredInvariants[0]).toEqual({
      invariant_id: "BR-24",
      display_label: "Failed contact attempts ≥ threshold",
    });
    expect(dto?.triggeredInvariants[0]).not.toHaveProperty(
      "triggering_record_id",
    );
    // Record-bearing BR-25 — `triggering_record_id` populated for UI deep-link.
    expect(dto?.triggeredInvariants[1]).toEqual({
      invariant_id: "BR-25",
      display_label: "Open Repair",
      triggering_record_id: "a5RU8000000RP1IAQ",
    });
  });

  it("flattens snapshots from multiple owners in input order", async () => {
    const result = await getCalibrationSet({
      ownerIds: ["005A", "005B"],
      factors: [],
      invariants: [],
      configuration: makeConfig({}),
      hydrate: async (ownerId) => ({
        snapshots: [
          makeSnapshot(`${ownerId}-P1`, ownerId),
          makeSnapshot(`${ownerId}-P2`, ownerId),
        ],
      }),
    });

    expect(result.map((p) => p.participantId)).toEqual([
      "005A-P1",
      "005A-P2",
      "005B-P1",
      "005B-P2",
    ]);
  });

  it("degrades only the participant whose factor throws; others still score", async () => {
    const throwingFactor: Factor = {
      key: "boom",
      displayName: "boom",
      type: "numeric",
      compute(participant: HydratedParticipant) {
        if (participant.participantId === "P-BAD") {
          throw new Error("boom threw for the synthetic guard test");
        }
        return { valueLabel: "ok", valueNumeric: 0 };
      },
    };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await getCalibrationSet({
      ownerIds: ["005A"],
      factors: [makeFactor("days_since_last_contact", 60), throwingFactor],
      invariants: [],
      configuration: makeConfig({ days_since_last_contact: 1, boom: 1 }),
      hydrate: async (ownerId) => ({
        snapshots: [
          makeSnapshot("P-GOOD", ownerId),
          makeSnapshot("P-BAD", ownerId),
        ],
      }),
    });

    expect(result).toHaveLength(2);
    expect(result[0]?.participantId).toBe("P-GOOD");
    expect(result[0]?.scored).toBe(true);
    expect(result[1]?.participantId).toBe("P-BAD");
    expect(result[1]?.scored).toBe(false);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(String(warnSpy.mock.calls[0]?.[0])) as Record<
      string,
      unknown
    >;
    expect(logged).toMatchObject({
      event: "calibration.participant_degraded",
      participantId: "P-BAD",
      ownerId: "005A",
      factorKey: "boom",
    });
    warnSpy.mockRestore();
  });

  it("degrades — does not throw — when the unit_engagement factor trips on a missing input (AC-3)", async () => {
    // The retired BR-19 factor (e): the projection never populates the
    // `unit_engagement` key, so the factor throws. The guard must turn that
    // into a degraded row, not a thrown request.
    const unitEngagementFactor: Factor = {
      key: "unit_engagement",
      displayName: "Unit engagement",
      type: "categorical",
      compute(participant: HydratedParticipant) {
        const raw = participant["unit_engagement"];
        if (typeof raw !== "string") {
          throw new Error(`unit_engagement must be string, got ${typeof raw}`);
        }
        return { valueLabel: raw, valueNumeric: 0 };
      },
    };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await getCalibrationSet({
      ownerIds: ["005A"],
      factors: [unitEngagementFactor],
      invariants: [],
      configuration: makeConfig({ unit_engagement: 1 }),
      hydrate: async (ownerId) => ({
        snapshots: [makeSnapshot("P-1", ownerId)],
      }),
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.scored).toBe(false);
    const logged = JSON.parse(String(warnSpy.mock.calls[0]?.[0])) as Record<
      string,
      unknown
    >;
    expect(logged.factorKey).toBe("unit_engagement");
    warnSpy.mockRestore();
  });

  it("scores a realistic snapshot end-to-end with the live factor registry", async () => {
    const now = new Date("2026-05-21T12:00:00Z");
    const offset = (days: number): Date =>
      new Date(now.getTime() + days * MS_PER_DAY);
    const snapshot = makeSnapshot("P-REAL", "005A", {
      enrollment: {
        mostRecentSuccessfulContact: offset(-10),
        dueDates: dueDatesWith(offset(7)),
        checkInsAttempted: 4,
        voucherRecertDeadline: offset(20),
        aftercareExtended: true,
      },
      barriers: [
        makeBarrier({
          type: "Cannot reach participant",
          stage: "Aftercare",
          endDate: null,
        }),
      ],
      incidents: [makeIncident({ incidentDate: offset(-5) })],
      arrears: [makeArrear({ status: "Identified" })],
    });

    const factors = getActiveFactors();
    const result = await getCalibrationSet({
      ownerIds: ["005A"],
      factors,
      invariants: [],
      configuration: getCalibrationConfiguration(),
      hydrate: async () => ({ snapshots: [snapshot] }),
      now: () => now,
    });

    expect(result).toHaveLength(1);
    const dto = result[0];
    expect(dto?.scored).toBe(true);
    expect(Number.isFinite(dto?.priorityScore)).toBe(true);
    expect(dto?.factors).toHaveLength(factors.length);

    const row = (key: string) => dto?.factors.find((f) => f.key === key);
    expect(row("days_since_last_contact")?.valueNumeric).toBe(10);
    // checkInsAttempted: 4 saturates at the BR-24 threshold (3) per P0-14 —
    // the soft score flattens once the invariant has already fired.
    expect(row("failed_attempts")?.valueNumeric).toBe(3);
    expect(row("recent_incident")?.valueNumeric).toBe(1);
    expect(row("aftercare_extended")?.valueNumeric).toBe(1);
    expect(row("arrears")?.valueNumeric).toBe(1);
    expect(row("stability_visit_state")?.valueLabel).toBe("Upcoming");
    expect(row("open_barriers")?.valueLabel).toContain("1 open");
  });
});
