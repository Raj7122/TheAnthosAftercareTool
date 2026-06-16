// Selects the feature-flag provider from the environment — the single point
// where the Demo-Mode vendor choice (Vercel Edge Config) is bound. Mirrors
// selectSalesforceAuth() in @anthos/api: the Edge Config adapter is used when
// its connection string is present (the deployed Vercel app), otherwise the
// local env-var provider (local dev, CI, tests).
//
// At Production cutover this is the function that swaps to a LaunchDarkly
// provider; FeatureFlagClient and every consumer are untouched.
import { ENV_EDGE_CONFIG } from "./config.js";
import { EdgeConfigFeatureFlagProvider } from "./providers/edge-config-provider.js";
import { LocalFeatureFlagProvider } from "./providers/local-provider.js";
import type { FeatureFlagProvider } from "./types.js";

type Env = Record<string, string | undefined>;

export function selectFeatureFlagProvider(
  env: Env = process.env,
): FeatureFlagProvider {
  // Constant key — `env` is a plain string map, so the object-injection
  // heuristic is a false positive here.
  // eslint-disable-next-line security/detect-object-injection
  const edgeConfig = env[ENV_EDGE_CONFIG];
  if (typeof edgeConfig === "string" && edgeConfig.trim().length > 0) {
    return new EdgeConfigFeatureFlagProvider();
  }
  return new LocalFeatureFlagProvider();
}
