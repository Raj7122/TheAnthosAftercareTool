// Sentinel errors raised by the M-AUDIT writer. Discriminated by class so
// callers can branch on `error instanceof AuditPiiError` without matching
// error-message strings. Mirrors the persistence repository error style.

import type { ZodIssue } from "zod";

export class AuditValidationError extends Error {
  override readonly name = "AuditValidationError";
  readonly issues: ZodIssue[];

  constructor(issues: ZodIssue[]) {
    super(
      "Audit entry failed schema validation (SEC-AUDIT-1a). See .issues for details.",
    );
    this.issues = issues;
  }
}

export class AuditPiiError extends Error {
  override readonly name = "AuditPiiError";
  readonly keyPath: string;
  readonly rule: string;

  // The offending value is deliberately NOT captured: it is the suspected PII,
  // and this error reaches logs/diagnostics (SEC-AUDIT-4). Only the location
  // (keyPath) and which heuristic fired (rule) are surfaced.
  constructor(keyPath: string, rule: string) {
    super(
      `payload_metadata failed the no-PII assertion (SEC-AUDIT-4): rule '${rule}' matched at '${keyPath}'. The offending value is withheld from this error.`,
    );
    this.keyPath = keyPath;
    this.rule = rule;
  }
}
