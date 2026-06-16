// BFF accessor for the feature-flag wrapper (DEPLOY-6: the flag service is
// integrated at the BFF layer from Sprint 1). Route handlers and Next.js
// Server Components reach flags through getFeatureFlagClient(); no host
// surface imports a provider SDK directly.
//
// The client is a process-scoped lazy singleton: the provider is selected
// from the environment once (Edge Config when EDGE_CONFIG is set, else the
// local env-var provider) and reused across requests. Tests construct their
// own FeatureFlagClient with an explicit provider and never call this.
import {
  createFeatureFlagClient,
  type FeatureFlagClient,
} from "@anthos/feature-flags";

let client: FeatureFlagClient | undefined;

export function getFeatureFlagClient(): FeatureFlagClient {
  client ??= createFeatureFlagClient();
  return client;
}
