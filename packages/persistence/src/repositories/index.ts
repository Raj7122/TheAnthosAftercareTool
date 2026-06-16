export {
  activateConfiguration,
  createConfiguration,
  getActiveConfiguration,
  getConfiguration,
  listConfigurationVersions,
} from "./config.js";
export type {
  ActivateConfigurationOptions,
  ActivateConfigurationResult,
  ConfigurationSummary,
  CreateConfigurationOptions,
  CreateConfigurationResult,
} from "./config.js";

export {
  buildActivationAuditRows,
  buildPayloadAuditRows,
  PAYLOAD_FIELDS,
} from "./config-diff.js";
export type { AuditRowDraft, DiffContext } from "./config-diff.js";

export {
  DEFAULT_FRESHNESS_WINDOW_SECONDS,
  getCaseloadCache,
  invalidateCaseloadCache,
  setCaseloadCache,
} from "./caseload-cache.js";
export type {
  CacheFreshness,
  CaseloadCacheKey,
  CaseloadCacheReadResult,
  InvalidateScope,
  SetCaseloadCacheInput,
} from "./caseload-cache.js";

export {
  evaluateRecoveryMode,
  readCursors,
  readStaleness,
  recordCycle,
} from "./cdc-health.js";
export type {
  CdcHealthRow,
  CursorMap,
  CycleSubscriptionStatus,
  RecordCycleInput,
  RecoveryMode,
  StalenessSummary,
} from "./cdc-health.js";

export {
  acquireIdempotencyLock,
  cleanupExpiredIdempotencyKeys,
  deleteIdempotencyKey,
  getIdempotencyKey,
  markIdempotencyCompleted,
  markIdempotencyFailedTerminal,
} from "./idempotency.js";
export type {
  AcquireIdempotencyLockInput,
  IdempotencyKeyRow,
} from "./idempotency.js";

export { checkAndConsumeRateLimit } from "./rate-limits.js";

export { getFirstRunCompleted } from "./notification-preferences.js";

export {
  NON_TERMINAL_STATUSES,
  QUEUE_PENDING_MAX_ITEMS,
  applyQueueResolution,
  findQueueItemById,
  getPendingForSpecialist,
} from "./offline-queue.js";
export type {
  ApplyQueueResolutionInput,
  NonTerminalStatus,
  OfflineQueueRow,
  PendingQueueResult,
  StatusCounts,
} from "./offline-queue.js";

export {
  applySessionRefresh,
  cleanupExpiredSessions,
  createSession,
  getSessionByTokenHash,
  getSessionRefreshToken,
  revokeSession,
  touchSession,
} from "./sessions.js";
export type { CreateSessionInput, SessionRow } from "./sessions.js";

export {
  BootstrapConflictError,
  ConfigurationNotFoundError,
  MalformedConfigurationError,
  NoActiveConfigurationError,
  UnauthorizedRoleError,
} from "./errors.js";
