// Sentinel error raised by the @anthos/logging PII firewall. Discriminated by
// class so callers branch on `err instanceof LogPiiError` without matching
// message strings. Mirrors @anthos/audit's AuditPiiError.

export class LogPiiError extends Error {
  override readonly name = "LogPiiError";
  readonly keyPath: string;
  readonly rule: string;

  // The offending value is deliberately NOT captured: it is suspected PII and
  // this error reaches logs/diagnostics. Only the location (keyPath) and which
  // heuristic fired (rule) are surfaced (SEC-AUDIT-4).
  constructor(keyPath: string, rule: string) {
    super(
      `A log record failed the no-PII firewall (SEC-AUDIT-4): rule '${rule}' matched at '${keyPath}'. The offending value is withheld from this error.`,
    );
    this.keyPath = keyPath;
    this.rule = rule;
  }
}
