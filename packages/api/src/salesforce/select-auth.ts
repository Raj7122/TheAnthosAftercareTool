// Salesforce auth-class selection for BFF-side Salesforce reads (P0-12a).
//
// The deployed BFF (Vercel) has no `sf` CLI keychain, so it authenticates via
// the PF-09 Connected App's refresh-token grant when all four credential env
// vars are present; local engineering falls back to `SfCliKeychainAuth`. The
// Connected App env-var presence check mirrors the credentials
// `SalesforceConnectedAppAuth`'s constructor requires, so the constructor
// never throws on this path.
//
// Extracted from `calibration/get-calibration-set.ts` (P1C-01) so both the
// calibration orchestrator and the caseload scoring kernel resolve auth the
// same way without either reaching into the other's module.

import {
  SalesforceConnectedAppAuth,
  SfCliKeychainAuth,
  type SalesforceAuth,
} from "@anthos/integrations";

export function selectSalesforceAuth(): SalesforceAuth {
  const hasConnectedAppCreds =
    isNonEmptyEnv("SF_CONNECTED_APP_CONSUMER_KEY") &&
    isNonEmptyEnv("SF_CONNECTED_APP_CONSUMER_SECRET") &&
    isNonEmptyEnv("SF_LOGIN_URL") &&
    isNonEmptyEnv("SF_CONNECTED_APP_REFRESH_TOKEN");
  return hasConnectedAppCreds
    ? new SalesforceConnectedAppAuth()
    : new SfCliKeychainAuth();
}

function isNonEmptyEnv(name: string): boolean {
  const value = process.env[name];
  return typeof value === "string" && value.trim().length > 0;
}
