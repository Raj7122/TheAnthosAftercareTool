// Local feature-flag provider — an in-memory rule map. Used for local
// development (seeded from ANTHOS_FEATURE_FLAGS) and for every unit test
// (seeded from an injected map). Pure, no network, no vendor SDK.
//
// This is the peer of the Edge Config adapter: the provider selector falls
// back here when no Edge Config connection string is present, mirroring the
// Salesforce CLI-keychain vs Connected-App dual-adapter pattern.
import { loadFeatureFlagsConfig } from "../config.js";
import { evaluateRule } from "../rule.js";
import type {
  FeatureFlagProvider,
  FlagEvaluation,
  FlagRule,
  SpecialistContext,
} from "../types.js";

export class LocalFeatureFlagProvider implements FeatureFlagProvider {
  private readonly rules: ReadonlyMap<string, FlagRule>;

  // Tests pass an explicit rule map; local dev passes nothing and the rules
  // load from ANTHOS_FEATURE_FLAGS.
  constructor(rules?: ReadonlyMap<string, FlagRule>) {
    this.rules = rules ?? loadFeatureFlagsConfig();
  }

  // Resolves to null when the flag key is absent — the client maps that to
  // the default (OFF). A present rule is evaluated against the context.
  async evaluate(
    flagKey: string,
    context: SpecialistContext,
  ): Promise<FlagEvaluation | null> {
    const rule = this.rules.get(flagKey);
    if (rule === undefined) {
      return null;
    }
    return evaluateRule(rule, context);
  }
}
