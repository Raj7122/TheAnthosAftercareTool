import { z } from "zod";

// Audit channels — must match the audit_log.channel CHECK constraint
// (ERD §6.1). Validated here so a bad channel fails at the app layer with a
// structured error rather than an opaque DB constraint violation.
export const AUDIT_CHANNELS = [
  "phone",
  "sms",
  "email",
  "in_person",
  "tablet",
  "desktop",
  "system",
] as const;

// Outcome — matches the audit_log.outcome CHECK constraint (SEC-AUDIT-1a).
export const AUDIT_OUTCOMES = ["SUCCESS", "FAILED", "QUEUED"] as const;

export type AuditChannel = (typeof AUDIT_CHANNELS)[number];
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

// One audit-log entry as accepted by writeAuditEntry(). `actionType`,
// `specialistId`, and `outcome` are required (SEC-AUDIT-1a). `payloadMetadata`
// holds structural facts only — the no-PII assertion enforces SEC-AUDIT-4.
export const auditEntrySchema = z.object({
  specialistId: z.string().min(1).max(50),
  actionType: z.string().min(1).max(100),
  outcome: z.enum(AUDIT_OUTCOMES),
  participantId: z.string().min(1).max(50).optional(),
  channel: z.enum(AUDIT_CHANNELS).optional(),
  salesforceRecordId: z.string().min(1).max(50).optional(),
  traceId: z.string().min(1).max(100).optional(),
  payloadMetadata: z.record(z.unknown()).default({}),
});

// Input type (the writer's parameter): `payloadMetadata` is optional because
// the schema supplies a default. Derived from the schema so it cannot drift.
export type AuditEntryInput = z.input<typeof auditEntrySchema>;

// Parsed type: all fields resolved, `payloadMetadata` always present.
export type AuditEntryParsed = z.output<typeof auditEntrySchema>;
