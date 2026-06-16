// Hash-chain interface — Pattern B / ERD §6.1.
//
// Demo Mode: the SHA-256 hash chain is slaughter-list item #3. The audit_log
// table carries no previous_hash / current_hash columns and computeHash
// returns null. The signature is load-bearing: at the production-cutover
// ratchet the body is swapped for
//   SHA-256(canonical_json(entry) || previousHash)
// (canonicalised via fast-json-stable-stringify) and a migration adds the two
// columns. This signature and writeAuditEntry's public API do not change.

// The audit_log columns the production hash is computed over (ERD §6.1). `id`
// and `timestamp` are DB-generated and join the canonical form at cutover.
export interface HashableAuditRow {
  specialistId: string;
  participantId: string | null;
  actionType: string;
  outcome: string;
  channel: string | null;
  salesforceRecordId: string | null;
  traceId: string | null;
  payloadMetadata: Record<string, unknown>;
}

// Demo Mode stub — returns null (no chain value persisted). Production cutover
// swaps this body; the (entry, previousHash) → string | null signature is
// stable so call sites are untouched.
export function computeHash(
  _entry: HashableAuditRow,
  _previousHash: string | null,
): string | null {
  return null;
}

// Hash-chain columns to merge into the audit_log INSERT. Demo Mode returns an
// empty object, so the writer's `.values()` spread contributes nothing against
// the column-less Demo schema. Production cutover returns
// `{ previousHash, currentHash: computeHash(entry, previousHash) }` once the
// migration adds the columns. writeAuditEntry's public signature is unchanged,
// but its body then fetches the prior row's current_hash (within the caller's
// transaction) to supply `previousHash` — today it passes null.
export function hashColumns(
  _entry: HashableAuditRow,
  _previousHash: string | null,
) {
  return {};
}
