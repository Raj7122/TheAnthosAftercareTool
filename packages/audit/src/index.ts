// M-AUDIT — audit_log writer, schema validation, no-PII assertions, and the
// hash-chain interface (Pattern B; SAD §8).

export { writeAuditEntry } from "./writer.js";
export type { WriteAuditEntryResult } from "./writer.js";

export {
  auditEntrySchema,
  AUDIT_CHANNELS,
  AUDIT_OUTCOMES,
} from "./schema.js";
export type {
  AuditEntryInput,
  AuditEntryParsed,
  AuditChannel,
  AuditOutcome,
} from "./schema.js";

export { assertNoPii, PII_KEY_DENYLIST, PII_VALUE_PATTERNS } from "./no-pii.js";

export { computeHash, hashColumns } from "./hash-chain.js";
export type { HashableAuditRow } from "./hash-chain.js";

export { AuditValidationError, AuditPiiError } from "./errors.js";
