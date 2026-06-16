import type { QuickActionDisabledReason } from "@anthos/api";

// Maps E-08's `quickActions.*DisabledReason` enum to the user-facing tooltip
// copy specialists see on hover/long-press. The four mappings are called out
// verbatim in P1F-08 §Notes — keep this module aligned with that spec.
//
// `consent_unknown` carries the schema-gap stub posture from P1F-01 (no SF
// SMS-consent source today); the copy reflects that without exposing the
// internal stub vocabulary.
const COPY: Readonly<Record<QuickActionDisabledReason, string>> = {
  supervisor_read_only: "Read-only access for supervisors",
  no_phone_on_file: "No phone number on file",
  no_email_on_file: "No email on file",
  consent_unknown: "Consent status unknown",
};

export function quickActionDisabledCopy(
  reason: QuickActionDisabledReason | undefined,
): string | undefined {
  if (reason === undefined) return undefined;
  return COPY[reason];
}
