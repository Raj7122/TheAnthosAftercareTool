// Public type surface for the feature-flag SDK wrapper (P1A-05, ARC-22).
//
// The wrapper hides the flag vendor behind these types so feature code never
// imports a provider SDK directly. The Demo-Mode provider is Vercel Edge
// Config; Production swaps to LaunchDarkly with this surface unchanged.
import type { Role } from "@anthos/auth";

// The evaluation context. PII-free by construction (no PII in logs):
// the Salesforce User ID and role are the only fields — never a participant
// identifier, name, email, or message content.
export interface SpecialistContext {
  // Salesforce User ID of the specialist (ERD: varchar(50)).
  readonly specialistId: string;
  readonly role: Role;
}

// The resolved state of one flag for one specialist. `variant` is null when
// the flag is off, or on without a named variant.
export interface FlagEvaluation {
  readonly enabled: boolean;
  readonly variant: string | null;
}

// A stored flag definition, authored by operators in the provider backend
// (an Edge Config item, or the ANTHOS_FEATURE_FLAGS env var for local dev).
//
// Targeting: an `enabled` rule with neither target list present is on for
// everyone. With either list present, the rule resolves ON for a specialist
// who matches *either* list — a targeted Salesforce User ID OR a targeted
// role (the two lists are OR'd, never AND'd). Default state is OFF — an
// unknown flag key is never represented by a rule at all.
export interface FlagRule {
  // Master switch. `false` forces the flag off for everyone (kill switch).
  readonly enabled: boolean;
  // Allowlist of Salesforce User IDs the flag is on for, when present.
  readonly targetSpecialistIds?: readonly string[];
  // Allowlist of roles the flag is on for, when present.
  readonly targetRoles?: readonly Role[];
  // Variant name returned by getVariant when the flag resolves on.
  readonly variant?: string;
}

// The vendor adapter contract. One method keeps the seam minimal; the client
// derives isEnabled / getVariant from it. `evaluate` resolves to null when
// the flag key is unknown to the backend — the client treats that as OFF.
export interface FeatureFlagProvider {
  evaluate(
    flagKey: string,
    context: SpecialistContext,
  ): Promise<FlagEvaluation | null>;
}
