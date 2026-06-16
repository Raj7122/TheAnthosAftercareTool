import type { DbOrTx } from "@anthos/persistence";
import { auditLog } from "@anthos/persistence/schema";

import { AuditValidationError } from "./errors.js";
import { hashColumns, type HashableAuditRow } from "./hash-chain.js";
import { assertNoPii } from "./no-pii.js";
import {
  auditEntrySchema,
  type AuditEntryInput,
  type AuditEntryParsed,
} from "./schema.js";

export interface WriteAuditEntryResult {
  readonly id: string;
}

// Pattern B / Immutable #5 (SEC-AUDIT-1a/4): writes exactly one audit_log row,
// awaited inside the caller's mutation handler BEFORE the HTTP response is
// returned. Accepts a DbOrTx handle so the audit INSERT shares the mutation's
// transaction boundary — the writer opens no transaction of its own. If this
// throws (schema validation, no-PII assertion, or DB failure) the caller's
// mutation MUST fail; there is no fire-and-forget path.
export async function writeAuditEntry(
  db: DbOrTx,
  entry: AuditEntryInput,
): Promise<WriteAuditEntryResult> {
  const parsed = parseEntry(entry);
  assertNoPii(parsed.payloadMetadata);

  const row: HashableAuditRow = {
    specialistId: parsed.specialistId,
    participantId: parsed.participantId ?? null,
    actionType: parsed.actionType,
    outcome: parsed.outcome,
    channel: parsed.channel ?? null,
    salesforceRecordId: parsed.salesforceRecordId ?? null,
    traceId: parsed.traceId ?? null,
    payloadMetadata: parsed.payloadMetadata,
  };

  const inserted = await db
    .insert(auditLog)
    .values({ ...row, ...hashColumns(row, null) })
    .returning({ id: auditLog.id });

  const written = inserted[0];
  if (!written) {
    throw new Error(
      "audit_log INSERT returned no row — audit entry not durable (SEC-AUDIT-1a).",
    );
  }
  return { id: written.id };
}

function parseEntry(entry: AuditEntryInput): AuditEntryParsed {
  const result = auditEntrySchema.safeParse(entry);
  if (!result.success) {
    throw new AuditValidationError(result.error.issues);
  }
  return result.data;
}
