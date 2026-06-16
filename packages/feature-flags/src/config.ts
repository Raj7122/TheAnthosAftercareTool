// Environment-driven configuration for the feature-flag wrapper.
//
// ENV_FEATURE_FLAGS seeds the LocalFeatureFlagProvider (local dev + tests):
// a JSON object mapping flag key -> FlagRule. ENV_EDGE_CONFIG is the Vercel
// Edge Config connection string; the provider selector picks the Edge Config
// adapter when it is present (see provider-selector.ts).
//
// Fail-loud: an absent var yields the safe default (no flags -> every flag
// resolves OFF); a present-but-malformed var throws — garbage flag config is
// operator error and must not silently resolve to a wrong rollout.
import { parseFlagRule } from "./rule.js";
import type { FlagRule } from "./types.js";

export const ENV_FEATURE_FLAGS = "ANTHOS_FEATURE_FLAGS";
export const ENV_EDGE_CONFIG = "EDGE_CONFIG";

type Env = Record<string, string | undefined>;

// Bracketed read with a constant key — `env` is a plain string map and `key`
// is always a module-level ENV_* constant, never user input, so the
// object-injection heuristic is a false positive here.
function readEnv(env: Env, key: string): string | undefined {
  // eslint-disable-next-line security/detect-object-injection
  return env[key];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Resolve the local flag rules from ANTHOS_FEATURE_FLAGS. Absent/blank -> an
// empty map (fail-closed: every flag key is then unknown -> OFF). Malformed
// JSON, a non-object payload, or a malformed rule throws, naming the env var.
export function loadFeatureFlagsConfig(
  env: Env = process.env,
): ReadonlyMap<string, FlagRule> {
  const raw = readEnv(env, ENV_FEATURE_FLAGS);
  if (raw === undefined || raw.trim().length === 0) {
    return new Map();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`${ENV_FEATURE_FLAGS} must be valid JSON: ${reason}`);
  }
  if (!isPlainObject(parsed)) {
    throw new Error(
      `${ENV_FEATURE_FLAGS} must be a JSON object of flag key -> rule.`,
    );
  }
  // Object.entries yields own enumerable keys only — no prototype lookup and
  // no dynamic bracket indexing on the untrusted parsed payload.
  const rules = new Map<string, FlagRule>();
  for (const [flagKey, value] of Object.entries(parsed)) {
    rules.set(
      flagKey,
      parseFlagRule(value, `${ENV_FEATURE_FLAGS}["${flagKey}"]`),
    );
  }
  return rules;
}
