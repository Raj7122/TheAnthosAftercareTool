// Structured, PII-free logging for flag evaluation. Mirrors the repo's
// console.warn(JSON.stringify(...)) convention (e.g. the session middleware
// and the calibration degradation logger). The payload carries the flag key
// and the specialist's role only — never the Salesforce User ID or any
// participant data (no PII in logs).
import type { Role } from "@anthos/auth";

// An unknown flag key resolved to the default (OFF). Surfaced, not thrown:
// the ticket requires an unknown key to return OFF with a logged warning.
export function logUnknownFlag(flagKey: string, role: Role): void {
  console.warn(
    JSON.stringify({ event: "feature_flags.unknown_flag", flagKey, role }),
  );
}

// The provider threw — e.g. a malformed Edge Config item or rule. We never
// catch errors silently: the client fails closed to OFF and records the
// reason here. The reason is a provider/validation message, never PII.
export function logEvaluationError(
  flagKey: string,
  role: Role,
  err: unknown,
): void {
  const reason = err instanceof Error ? err.message : String(err);
  console.warn(
    JSON.stringify({
      event: "feature_flags.evaluation_error",
      flagKey,
      role,
      reason,
    }),
  );
}
