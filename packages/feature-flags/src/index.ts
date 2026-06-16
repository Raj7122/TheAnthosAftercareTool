// @anthos/feature-flags — vendor-agnostic feature-flag SDK wrapper (P1A-05,
// ARC-22 / NFR-MAINT-5 / DEPLOY-6). Feature code imports only from this
// barrel; the vendor SDK stays behind the EdgeConfigFeatureFlagProvider
// adapter and is never imported elsewhere.
//
// The barrel is the public seam: FeatureFlagClient + createFeatureFlagClient
// are what feature code uses. The provider classes are exposed so a caller
// can construct one explicitly. The env-based selector and the config loader
// are internal wiring and are intentionally NOT re-exported here — they are
// exported from their own modules only (for tests), mirroring how @anthos/api
// keeps selectSalesforceAuth off its barrel.
export { FeatureFlagClient, createFeatureFlagClient } from "./client.js";
export { LocalFeatureFlagProvider } from "./providers/local-provider.js";
export { EdgeConfigFeatureFlagProvider } from "./providers/edge-config-provider.js";
export type {
  EdgeConfigFeatureFlagProviderOptions,
  EdgeConfigReader,
} from "./providers/edge-config-provider.js";
export type {
  FeatureFlagProvider,
  FlagEvaluation,
  FlagRule,
  SpecialistContext,
} from "./types.js";
