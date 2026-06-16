import type { Actor } from "@anthos/auth";
import type { ConfigurationPayload } from "@anthos/domain";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// This suite hits a real Postgres (Supabase/Neon) via DEMO_POSTGRES_URL. It is
// the round-trip proof for Pattern B's "audit row written BEFORE response"
// invariant — after `createConfiguration` resolves, `configuration_audit` rows
// must already be visible on a fresh connection (commit ordering invariant).
// Skipped when DEMO_POSTGRES_URL is unset so CI stays green pre-P1A-01.

const RUN = !!process.env.DEMO_POSTGRES_URL;

const ADMIN: Actor = { id: "admin-test", role: "SYSTEM_ADMIN" };
const SPECIALIST: Actor = { id: "specialist-test", role: "SPECIALIST" };

describe.skipIf(!RUN)("config repository (integration)", () => {
  // Lazy-imported so client.ts (which throws on missing DEMO_POSTGRES_URL)
  // never evaluates when the suite is skipped.
  let db: typeof import("../../src/db/client.js")["db"];
  let closeDb: typeof import("../../src/db/client.js")["closeDb"];
  let schema: typeof import("../../src/schema/index.js");
  let repo: typeof import("../../src/repositories/index.js");

  beforeAll(async () => {
    ({ db, closeDb } = await import("../../src/db/client.js"));
    schema = await import("../../src/schema/index.js");
    repo = await import("../../src/repositories/index.js");
  });

  afterAll(async () => {
    await closeDb();
  });

  beforeEach(async () => {
    await db.execute(
      sql`TRUNCATE TABLE configuration_audit, configuration RESTART IDENTITY CASCADE`,
    );
  });

  it("bootstrap create writes version=1 with one audit row per payload column", async () => {
    const result = await repo.createConfiguration(db, {
      actor: ADMIN,
      reason: "bootstrap v1",
      payload: makePayload(),
      basedOn: null,
    });
    expect(result.version).toBe(1);
    expect(result.auditRowIds.length).toBe(repo.PAYLOAD_FIELDS.length);

    const auditRows = await db.select().from(schema.configurationAudit);
    expect(auditRows).toHaveLength(repo.PAYLOAD_FIELDS.length);
    expect(auditRows.every((r) => r.versionFrom === null && r.versionTo === 1)).toBe(
      true,
    );
    expect(auditRows.every((r) => r.actorId === ADMIN.id)).toBe(true);
  });

  it("bootstrap with prior versions in the table is rejected", async () => {
    await repo.createConfiguration(db, {
      actor: ADMIN,
      reason: "bootstrap v1",
      payload: makePayload(),
      basedOn: null,
    });
    await expect(
      repo.createConfiguration(db, {
        actor: ADMIN,
        reason: "second bootstrap",
        payload: makePayload(),
        basedOn: null,
      }),
    ).rejects.toBeInstanceOf(repo.BootstrapConflictError);
  });

  it("create with basedOn=N emits one audit row per changed payload column", async () => {
    await repo.createConfiguration(db, {
      actor: ADMIN,
      reason: "bootstrap v1",
      payload: makePayload(),
      basedOn: null,
    });
    const next: ConfigurationPayload = {
      ...makePayload(),
      tieBreakerStrategy: "lowest_id",
    };
    const result = await repo.createConfiguration(db, {
      actor: ADMIN,
      reason: "tweak tie-breaker",
      payload: next,
      basedOn: 1,
    });
    expect(result.version).toBe(2);
    expect(result.auditRowIds).toHaveLength(1);

    const auditRows = await db
      .select()
      .from(schema.configurationAudit)
      .where(sql`${schema.configurationAudit.versionTo} = 2`);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.fieldPath).toBe("tie_breaker_strategy");
    expect(auditRows[0]?.versionFrom).toBe(1);
  });

  it("getActiveConfiguration returns the active row after activation", async () => {
    await repo.createConfiguration(db, {
      actor: ADMIN,
      reason: "bootstrap",
      payload: makePayload(),
      basedOn: null,
    });
    await expect(repo.getActiveConfiguration(db)).rejects.toBeInstanceOf(
      repo.NoActiveConfigurationError,
    );
    await repo.activateConfiguration(db, {
      actor: ADMIN,
      reason: "ship v1",
      version: 1,
    });
    const active = await repo.getActiveConfiguration(db);
    expect(active.version).toBe(1);
    expect(active.isActive).toBe(true);
    expect(active.activationAt).not.toBeNull();
  });

  it("activation swaps the active flag and writes is_active audit rows", async () => {
    await repo.createConfiguration(db, {
      actor: ADMIN,
      reason: "v1",
      payload: makePayload(),
      basedOn: null,
    });
    await repo.activateConfiguration(db, {
      actor: ADMIN,
      reason: "ship v1",
      version: 1,
    });
    await repo.createConfiguration(db, {
      actor: ADMIN,
      reason: "v2",
      payload: { ...makePayload(), tieBreakerStrategy: "lowest_id" },
      basedOn: 1,
    });
    const result = await repo.activateConfiguration(db, {
      actor: ADMIN,
      reason: "promote v2",
      version: 2,
    });
    expect(result.activatedVersion).toBe(2);
    expect(result.deactivatedVersion).toBe(1);

    const activeRows = await db
      .select()
      .from(schema.configuration)
      .where(sql`${schema.configuration.isActive} = true`);
    expect(activeRows).toHaveLength(1);
    expect(activeRows[0]?.version).toBe(2);

    const isActiveAuditRows = await db
      .select()
      .from(schema.configurationAudit)
      .where(sql`${schema.configurationAudit.fieldPath} = 'is_active'`);
    expect(isActiveAuditRows.length).toBeGreaterThanOrEqual(3); // v1 on, v1 off, v2 on
  });

  it("listConfigurationVersions returns summaries newest-first", async () => {
    await repo.createConfiguration(db, {
      actor: ADMIN,
      reason: "v1",
      payload: makePayload(),
      basedOn: null,
    });
    await repo.createConfiguration(db, {
      actor: ADMIN,
      reason: "v2",
      payload: { ...makePayload(), tieBreakerStrategy: "lowest_id" },
      basedOn: 1,
    });
    const list = await repo.listConfigurationVersions(db);
    expect(list.map((r) => r.version)).toEqual([2, 1]);
  });

  it("rejects mutations from non-admin actors (BR-13)", async () => {
    await expect(
      repo.createConfiguration(db, {
        actor: SPECIALIST,
        reason: "should fail",
        payload: makePayload(),
        basedOn: null,
      }),
    ).rejects.toBeInstanceOf(repo.UnauthorizedRoleError);
    await expect(
      repo.activateConfiguration(db, {
        actor: SPECIALIST,
        reason: "should fail",
        version: 1,
      }),
    ).rejects.toBeInstanceOf(repo.UnauthorizedRoleError);
  });

  it("getConfiguration throws ConfigurationNotFoundError for an unknown version", async () => {
    await expect(repo.getConfiguration(db, 99)).rejects.toBeInstanceOf(
      repo.ConfigurationNotFoundError,
    );
  });

  it("getConfiguration is fail-loud on malformed factor_weights (VR-05)", async () => {
    // Insert a row directly with raw SQL bypassing the typed mutator so we can
    // simulate corrupt data and prove the loader rejects it.
    await db.execute(sql`
      INSERT INTO configuration (
        version, is_active, created_by,
        factor_weights, tier_thresholds, queue_predicates, barrier_severity_classification,
        sbop_path
      ) VALUES (
        99, false, 'corrupt-fixture',
        '{"multiplicative_modifiers": {}, "overlap_caps": []}'::jsonb,
        '{"tier1_min": 80}'::jsonb,
        '{}'::jsonb,
        '{}'::jsonb,
        'A'
      )
    `);
    await expect(repo.getConfiguration(db, 99)).rejects.toBeInstanceOf(
      repo.MalformedConfigurationError,
    );
  });
});

function makePayload(): ConfigurationPayload {
  return {
    factorWeights: {
      additive: { days_since_last_contact: 1.5 },
      multiplicative_modifiers: {},
      overlap_caps: [],
    },
    tierThresholds: { tier1_min: 80, tier2_min: 50 },
    queuePredicates: {
      caseload_overview: {
        displayLabel: "Caseload overview",
        predicate: { kind: "all_active" },
        sortKey: "priority_score_desc",
        isDefault: true,
      },
    },
    barrierSeverityClassification: { "Cannot reach participant": "high" },
    barrierSeverityHigh: "3.00",
    barrierSeverityMedium: "2.00",
    barrierSeverityLow: "1.00",
    barrierStalenessMultiplier: "1.50",
    barrierStalenessThresholdDays: 30,
    tierInvariants: {
      failed_attempts_tier1_threshold: 3,
      barrier_type_to_invariant: {},
      open_repair_invariant: null,
      invariant_override_suppression: true,
    },

    dueStatusLeadTimeDays: 14,
    voucherRecertWarningDays: 30,
    recentIncidentWindowDays: 30,
    daysSinceContactScoringCapDays: 90,
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
    mogliBackoffSeconds: [5, 15, 45, 120, 300],

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
