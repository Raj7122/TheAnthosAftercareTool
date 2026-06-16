// Pure flag logic shared by every provider: validation of a stored rule and
// evaluation of a rule against a specialist context. No I/O, no vendor SDK —
// both the local and the Edge Config provider run identical targeting here,
// which is what makes the providers swappable behind one interface.
import type { Role } from "@anthos/auth";

import type { FlagEvaluation, FlagRule, SpecialistContext } from "./types.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === "string" && entry.length > 0)
  );
}

// Validate an untrusted value (parsed JSON from env or Edge Config) into a
// FlagRule. Throws — fail-loud — on a malformed rule: a bad rule is operator
// error and must not be silently coerced into a wrong rollout. `source` names
// the origin for the error message. Unknown extra keys are ignored so a newer
// rule schema does not break an older deployment (forward-compatible).
export function parseFlagRule(value: unknown, source: string): FlagRule {
  if (!isPlainObject(value)) {
    throw new Error(`${source}: flag rule must be a JSON object.`);
  }
  if (typeof value.enabled !== "boolean") {
    throw new Error(`${source}: flag rule "enabled" must be a boolean.`);
  }
  const enabled = value.enabled;

  let targetSpecialistIds: readonly string[] | undefined;
  if (value.targetSpecialistIds !== undefined) {
    if (!isNonEmptyStringArray(value.targetSpecialistIds)) {
      throw new Error(
        `${source}: "targetSpecialistIds" must be an array of non-empty strings.`,
      );
    }
    targetSpecialistIds = value.targetSpecialistIds;
  }

  let targetRoles: readonly Role[] | undefined;
  if (value.targetRoles !== undefined) {
    if (!isNonEmptyStringArray(value.targetRoles)) {
      throw new Error(
        `${source}: "targetRoles" must be an array of non-empty strings.`,
      );
    }
    // A role string that is not a real role simply never matches a live
    // ctx.role — fail-closed. This package deliberately does not couple to
    // @anthos/auth's runtime role list (the Role import here is type-only).
    targetRoles = value.targetRoles as readonly Role[];
  }

  let variant: string | undefined;
  if (value.variant !== undefined) {
    if (typeof value.variant !== "string" || value.variant.length === 0) {
      throw new Error(`${source}: "variant" must be a non-empty string.`);
    }
    variant = value.variant;
  }

  return {
    enabled,
    ...(targetSpecialistIds !== undefined ? { targetSpecialistIds } : {}),
    ...(targetRoles !== undefined ? { targetRoles } : {}),
    ...(variant !== undefined ? { variant } : {}),
  };
}

function onEvaluation(rule: FlagRule): FlagEvaluation {
  return { enabled: true, variant: rule.variant ?? null };
}

// Evaluate a known flag rule for one specialist. The default-OFF posture for
// an *unknown* flag lives in the caller (the client treats an absent rule as
// OFF); this function resolves a rule that exists. A disabled rule, or an
// enabled rule whose targeting the specialist does not match, is OFF.
export function evaluateRule(
  rule: FlagRule,
  context: SpecialistContext,
): FlagEvaluation {
  if (!rule.enabled) {
    return { enabled: false, variant: null };
  }
  const targetSpecialistIds = rule.targetSpecialistIds ?? [];
  const targetRoles = rule.targetRoles ?? [];

  // An enabled rule with no targeting is on for everyone.
  if (targetSpecialistIds.length === 0 && targetRoles.length === 0) {
    return onEvaluation(rule);
  }
  const matched =
    targetSpecialistIds.includes(context.specialistId) ||
    targetRoles.includes(context.role);

  return matched ? onEvaluation(rule) : { enabled: false, variant: null };
}
