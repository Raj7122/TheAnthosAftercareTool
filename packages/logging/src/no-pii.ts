// PII firewall for structured log records (SEC-AUDIT-4 by extension;
// no PII in logs). Reuses @anthos/audit's no-PII primitives so the
// audit_log.payload_metadata firewall and the log firewall share ONE source of
// truth — the denylist and value heuristics live in @anthos/audit.
//
// `message` is a required, free-text log field, so it cannot be denied
// outright; instead its value is scanned for the shared email/phone/hash
// heuristics. The structured `fields` object is scanned with the full audit
// assertion, which ALSO denies keys like `name` / `phone` / `email` /
// `message` / `content` — structurally refusing a caller that tries to smuggle
// message content into a field.

import { AuditPiiError } from "@anthos/audit/errors";
import { assertNoPii, PII_VALUE_PATTERNS } from "@anthos/audit/no-pii";

import { LogPiiError } from "./errors.js";

// Scan a free-text string against the shared value heuristics. Throws on the
// first heuristic that fires.
function assertMessageClean(message: string): void {
  for (const { rule, pattern } of PII_VALUE_PATTERNS) {
    if (pattern.test(message)) {
      throw new LogPiiError("message", `value:${rule}`);
    }
  }
}

// Throws LogPiiError on the first PII heuristic that fires across the log
// record's message or its structured fields. Runs before the record is
// serialized — a PII-bearing record never reaches the log stream.
export function assertLogSafe(
  message: string,
  fields: Record<string, unknown>,
): void {
  assertMessageClean(message);
  try {
    assertNoPii(fields);
  } catch (err) {
    if (err instanceof AuditPiiError) {
      // Re-root the path from audit's `payload_metadata` to `fields` so the
      // surfaced location reflects the log record, not the audit payload.
      const keyPath = err.keyPath.replace(/^payload_metadata/, "fields");
      throw new LogPiiError(keyPath, err.rule);
    }
    throw err;
  }
}
