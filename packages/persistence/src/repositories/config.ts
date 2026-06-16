import { isAdmin, type Actor } from "@anthos/auth";
import {
  configurationPayloadSchema,
  configurationSchema,
  type Configuration,
  type ConfigurationPayload,
} from "@anthos/domain";
import { desc, eq, max, sql } from "drizzle-orm";

import type { DbClient, DbOrTx } from "../db/types.js";
import { configuration, configurationAudit } from "../schema/index.js";

import {
  buildActivationAuditRows,
  buildPayloadAuditRows,
  type AuditRowDraft,
} from "./config-diff.js";
import {
  BootstrapConflictError,
  ConfigurationNotFoundError,
  MalformedConfigurationError,
  NoActiveConfigurationError,
  UnauthorizedRoleError,
} from "./errors.js";

const REQUIRED_ROLE = "SYSTEM_ADMIN";

function assertAdmin(actor: Actor): void {
  if (!isAdmin(actor.role)) {
    throw new UnauthorizedRoleError(actor.id, actor.role, REQUIRED_ROLE);
  }
}

function parseRow(row: unknown, expectedVersion?: number): Configuration {
  const parsed = configurationSchema.safeParse(row);
  if (!parsed.success) {
    const v =
      expectedVersion ??
      (typeof row === "object" && row !== null && "version" in row
        ? Number((row as { version: unknown }).version)
        : -1);
    throw new MalformedConfigurationError(v, parsed.error.issues);
  }
  return parsed.data;
}

function rowToPayload(row: Configuration): ConfigurationPayload {
  return {
    factorWeights: row.factorWeights,
    tierThresholds: row.tierThresholds,
    queuePredicates: row.queuePredicates,
    barrierSeverityClassification: row.barrierSeverityClassification,
    barrierSeverityHigh: row.barrierSeverityHigh,
    barrierSeverityMedium: row.barrierSeverityMedium,
    barrierSeverityLow: row.barrierSeverityLow,
    barrierStalenessMultiplier: row.barrierStalenessMultiplier,
    barrierStalenessThresholdDays: row.barrierStalenessThresholdDays,
    tierInvariants: row.tierInvariants,
    dueStatusLeadTimeDays: row.dueStatusLeadTimeDays,
    voucherRecertWarningDays: row.voucherRecertWarningDays,
    recentIncidentWindowDays: row.recentIncidentWindowDays,
    daysSinceContactScoringCapDays: row.daysSinceContactScoringCapDays,
    failedAttemptResetOnCompleted: row.failedAttemptResetOnCompleted,
    recalibrationCadenceDays: row.recalibrationCadenceDays,
    calibrationAlpha: row.calibrationAlpha,
    calibrationBeta: row.calibrationBeta,
    calibrationThresholdPct: row.calibrationThresholdPct,
    calibrationParticipantsFloor: row.calibrationParticipantsFloor,
    sbopPath: row.sbopPath,
    sbopSuppressionDays: row.sbopSuppressionDays,
    sbopEnabled: row.sbopEnabled,
    capacityStrainMultiplier: row.capacityStrainMultiplier,
    capacityStrainPersistenceDays: row.capacityStrainPersistenceDays,
    quietHoursStartLocal: row.quietHoursStartLocal,
    quietHoursEndLocal: row.quietHoursEndLocal,
    mogliTimeoutSeconds: row.mogliTimeoutSeconds,
    mogliBackoffSeconds: row.mogliBackoffSeconds,
    offlineMaxQueueDepth: row.offlineMaxQueueDepth,
    offlineMaxRetries: row.offlineMaxRetries,
    idempotencyTtlHours: row.idempotencyTtlHours,
    hardRefreshRateLimitSeconds: row.hardRefreshRateLimitSeconds,
    nightlyRefreshCron: row.nightlyRefreshCron,
    weeklyDigestCron: row.weeklyDigestCron,
    dailyDigestCron: row.dailyDigestCron,
    tieBreakerStrategy: row.tieBreakerStrategy,
    featureFlags: row.featureFlags,
    approvalMetadata: row.approvalMetadata,
    notes: row.notes,
  };
}

export async function getConfiguration(
  db: DbOrTx,
  version: number,
): Promise<Configuration> {
  const rows = await db
    .select()
    .from(configuration)
    .where(eq(configuration.version, version))
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw new ConfigurationNotFoundError(version);
  }
  return parseRow(row, version);
}

export async function getActiveConfiguration(db: DbOrTx): Promise<Configuration> {
  const rows = await db
    .select()
    .from(configuration)
    .where(eq(configuration.isActive, true))
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw new NoActiveConfigurationError();
  }
  return parseRow(row);
}

export interface ConfigurationSummary {
  version: number;
  isActive: boolean;
  createdAt: Date;
  createdBy: string;
}

export async function listConfigurationVersions(
  db: DbOrTx,
): Promise<ConfigurationSummary[]> {
  const rows = await db
    .select({
      version: configuration.version,
      isActive: configuration.isActive,
      createdAt: configuration.createdAt,
      createdBy: configuration.createdBy,
    })
    .from(configuration)
    .orderBy(desc(configuration.version));
  return rows;
}

export interface CreateConfigurationOptions {
  actor: Actor;
  reason: string;
  payload: ConfigurationPayload;
  // Pass an existing version number to fork from; pass null to bootstrap the
  // first row. Required so callers are explicit about lineage — the diff is
  // computed against `basedOn`, not the current active version implicitly.
  basedOn: number | null;
}

export interface CreateConfigurationResult {
  version: number;
  auditRowIds: string[];
}

export async function createConfiguration(
  db: DbClient,
  opts: CreateConfigurationOptions,
): Promise<CreateConfigurationResult> {
  assertAdmin(opts.actor);
  if (!opts.reason.trim()) {
    throw new Error("createConfiguration requires a non-empty reason (NFR-MAINT-3).");
  }
  const parsedPayload = configurationPayloadSchema.parse(opts.payload);

  return db.transaction(async (tx) => {
    const [maxRow] = await tx
      .select({ value: max(configuration.version) })
      .from(configuration);
    const currentMax = maxRow?.value ?? null;

    if (opts.basedOn === null && currentMax !== null) {
      throw new BootstrapConflictError();
    }

    let prior: ConfigurationPayload | null = null;
    if (opts.basedOn !== null) {
      const priorRow = await getConfiguration(tx, opts.basedOn);
      prior = rowToPayload(priorRow);
    }

    const nextVersion = (currentMax ?? 0) + 1;

    const auditDrafts = buildPayloadAuditRows(
      {
        versionFrom: opts.basedOn,
        versionTo: nextVersion,
        actor: opts.actor,
        reason: opts.reason,
      },
      prior,
      parsedPayload,
    );

    await tx.insert(configuration).values({
      version: nextVersion,
      isActive: false,
      createdBy: opts.actor.id,
      ...parsedPayload,
    });

    const inserted = await insertAuditRows(tx, auditDrafts);

    return { version: nextVersion, auditRowIds: inserted };
  });
}

export interface ActivateConfigurationOptions {
  actor: Actor;
  reason: string;
  version: number;
}

export interface ActivateConfigurationResult {
  activatedVersion: number;
  deactivatedVersion: number | null;
  auditRowIds: string[];
}

export async function activateConfiguration(
  db: DbClient,
  opts: ActivateConfigurationOptions,
): Promise<ActivateConfigurationResult> {
  assertAdmin(opts.actor);
  if (!opts.reason.trim()) {
    throw new Error("activateConfiguration requires a non-empty reason (NFR-MAINT-3).");
  }

  return db.transaction(async (tx) => {
    const target = await tx
      .select({ version: configuration.version, isActive: configuration.isActive })
      .from(configuration)
      .where(eq(configuration.version, opts.version))
      .limit(1);
    if (target.length === 0) {
      throw new ConfigurationNotFoundError(opts.version);
    }

    const currentActive = await tx
      .select({ version: configuration.version })
      .from(configuration)
      .where(eq(configuration.isActive, true))
      .limit(1);
    const deactivatingVersion = currentActive[0]?.version ?? null;

    const auditDrafts = buildActivationAuditRows({
      activatingVersion: opts.version,
      deactivatingVersion,
      actor: opts.actor,
      reason: opts.reason,
    });

    if (deactivatingVersion !== null && deactivatingVersion !== opts.version) {
      await tx
        .update(configuration)
        .set({ isActive: false, deactivatedAt: sql`NOW()` })
        .where(eq(configuration.version, deactivatingVersion));
    }
    if (deactivatingVersion !== opts.version) {
      await tx
        .update(configuration)
        .set({ isActive: true, activationAt: sql`NOW()` })
        .where(eq(configuration.version, opts.version));
    }

    const inserted = await insertAuditRows(tx, auditDrafts);

    return {
      activatedVersion: opts.version,
      deactivatedVersion: deactivatingVersion,
      auditRowIds: inserted,
    };
  });
}

async function insertAuditRows(
  tx: DbOrTx,
  drafts: AuditRowDraft[],
): Promise<string[]> {
  if (drafts.length === 0) {
    return [];
  }
  // `configuration_audit.new_value` is jsonb NOT NULL (ERD §6.7), but a payload
  // column may legitimately transition TO null (notes, approval_metadata).
  // Map JS null to the JSON null literal so the audit row is preserved without
  // violating the schema. priorValue stays as SQL NULL (column is nullable).
  const inserted = await tx
    .insert(configurationAudit)
    .values(
      drafts.map((d) => ({
        actorId: d.actorId,
        fieldPath: d.fieldPath,
        priorValue: d.priorValue,
        newValue: d.newValue === null ? sql`'null'::jsonb` : d.newValue,
        reason: d.reason,
        versionFrom: d.versionFrom,
        versionTo: d.versionTo,
      })),
    )
    .returning({ id: configurationAudit.id });
  return inserted.map((r) => r.id);
}
