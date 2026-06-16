import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SalesforceConnectedAppAuth, SfCliKeychainAuth } from "@anthos/integrations";

import { selectSalesforceAuth } from "../../src/salesforce/select-auth.js";

// P0-12a — the auth-class selection switch. The deployed BFF uses the PF-09
// Connected App; local engineering falls back to the `sf` CLI keychain.

const CONNECTED_APP_VARS = [
  "SF_CONNECTED_APP_CONSUMER_KEY",
  "SF_CONNECTED_APP_CONSUMER_SECRET",
  "SF_LOGIN_URL",
  "SF_CONNECTED_APP_REFRESH_TOKEN",
] as const;

describe("selectSalesforceAuth", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    // Snapshot + clear so the test is deterministic regardless of a loaded
    // `.env` on the engineer's machine.
    saved = {};
    for (const name of CONNECTED_APP_VARS) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
  });

  afterEach(() => {
    for (const name of CONNECTED_APP_VARS) {
      const value = saved[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("falls back to SfCliKeychainAuth when no Connected App env vars are set", () => {
    expect(selectSalesforceAuth()).toBeInstanceOf(SfCliKeychainAuth);
  });

  it("returns SalesforceConnectedAppAuth when all four credentials are present", () => {
    process.env.SF_CONNECTED_APP_CONSUMER_KEY = "test-key";
    process.env.SF_CONNECTED_APP_CONSUMER_SECRET = "test-secret";
    process.env.SF_LOGIN_URL = "https://anthoshome3--pursuit.sandbox.my.salesforce.com";
    process.env.SF_CONNECTED_APP_REFRESH_TOKEN = "test-refresh-token";

    expect(selectSalesforceAuth()).toBeInstanceOf(SalesforceConnectedAppAuth);
  });

  it("falls back to SfCliKeychainAuth when one credential is missing", () => {
    process.env.SF_CONNECTED_APP_CONSUMER_KEY = "test-key";
    process.env.SF_CONNECTED_APP_CONSUMER_SECRET = "test-secret";
    process.env.SF_LOGIN_URL = "https://anthoshome3--pursuit.sandbox.my.salesforce.com";
    // SF_CONNECTED_APP_REFRESH_TOKEN intentionally unset.

    expect(selectSalesforceAuth()).toBeInstanceOf(SfCliKeychainAuth);
  });

  it("treats a whitespace-only credential as absent", () => {
    process.env.SF_CONNECTED_APP_CONSUMER_KEY = "test-key";
    process.env.SF_CONNECTED_APP_CONSUMER_SECRET = "test-secret";
    process.env.SF_LOGIN_URL = "https://anthoshome3--pursuit.sandbox.my.salesforce.com";
    process.env.SF_CONNECTED_APP_REFRESH_TOKEN = "   ";

    expect(selectSalesforceAuth()).toBeInstanceOf(SfCliKeychainAuth);
  });
});
