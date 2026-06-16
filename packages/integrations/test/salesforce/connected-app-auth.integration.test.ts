import { describe, expect, it } from "vitest";

import { SalesforceConnectedAppAuth } from "../../src/salesforce/connected-app-auth.js";

// Opt-in live-sandbox test (P0-12a). Default-skipped in CI to keep the test
// pyramid hermetic (impl plan v1.4 §6.2). Exercises the refresh-token grant
// against the PF-09 Connected App on the anonymized `anthos-demo` sandbox.
//
// Requires, when RUN_SF_SANDBOX_TESTS=1:
//   - SF_CONNECTED_APP_CONSUMER_KEY    (PF-09)
//   - SF_CONNECTED_APP_CONSUMER_SECRET (PF-09)
//   - SF_LOGIN_URL                     (PF-09)
//   - SF_CONNECTED_APP_REFRESH_TOKEN   (P0-12a — minted by the one-time
//     auth-code+PKCE bootstrap)
//
// Unlike the `sf`-CLI integration test, a failing token exchange here is a
// REAL failure (bad/expired refresh token or wrong creds), not a skippable
// local-environment problem — so this test does not swallow SalesforceError.

const ENABLED = process.env.RUN_SF_SANDBOX_TESTS === "1";
const REQUIRED_VARS = [
  "SF_CONNECTED_APP_CONSUMER_KEY",
  "SF_CONNECTED_APP_CONSUMER_SECRET",
  "SF_LOGIN_URL",
  "SF_CONNECTED_APP_REFRESH_TOKEN",
] as const;

describe.skipIf(!ENABLED)(
  "SalesforceConnectedAppAuth — live sandbox (opt-in)",
  () => {
    it("exchanges the refresh token for a live access token + instance URL", async () => {
      const missing = REQUIRED_VARS.filter((v) => !process.env[v]);
      if (missing.length > 0) {
        throw new Error(
          `${missing.join(", ")} must be set when RUN_SF_SANDBOX_TESTS=1`,
        );
      }

      // Constructor defaults to the env vars above.
      const auth = new SalesforceConnectedAppAuth();

      const accessToken = await auth.getAccessToken();
      expect(accessToken.length).toBeGreaterThan(0);

      const instanceUrl = await auth.getInstanceUrl();
      expect(instanceUrl).toMatch(/^https:\/\/.+\.salesforce\.com$/);

      // Second call is served from cache — one token fetch only.
      expect(await auth.getAccessToken()).toBe(accessToken);
    }, 30_000);
  },
);
