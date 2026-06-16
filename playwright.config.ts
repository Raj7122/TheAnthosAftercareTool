// Playwright configuration for the P1B-07 OAuth + iframe E2E (the repo's first
// browser test). Two `webServer` processes are started and health-checked
// before any test runs:
//   1. the mock Salesforce server (authorize / token / SOQL + the iframe
//      parent page) — `apps/web/test/e2e/_support/mock-salesforce.ts`;
//   2. the BFF under test — `next build && next start`, env-wired below.
// No live network dependency on the Salesforce sandbox → deterministic in CI.
//
// E2E specs use the `*.e2e.ts` suffix (not `*.test.ts`) so vitest's
// `**/*.test.{ts,tsx}` glob never picks them up — the two runners stay
// disjoint with no `vitest.config.ts` change.

import { randomBytes } from "node:crypto";

import { defineConfig, devices } from "@playwright/test";

import {
  BFF_ORIGIN,
  CLIENT_ID,
  CLIENT_SECRET,
  MOCK_SF_ORIGIN,
  OAUTH_REDIRECT_URI,
  PERMISSION_SET_NAME,
  POSTGRES_URL,
} from "./apps/web/test/e2e/_support/constants.js";

// AES-256 keys for the encrypted OAuth cookies and the at-rest Salesforce
// refresh token. Generated per run — test-only keys guarding test-only
// ephemeral data; never a hard-coded secret in source (DoD: no secrets in
// fixtures / CI artifacts).
const oauthCookieKey = randomBytes(32).toString("base64");
const sfTokenEncKey = randomBytes(32).toString("base64");

// Env for the BFF. The single `command` runs `build` then `start` under this
// env, so build-time vars (ANTHOS_CSP_FRAME_ANCESTORS is baked into the route
// manifest by next.config.ts `headers()`) and per-request runtime vars are
// both covered.
const bffEnv: Record<string, string> = {
  NODE_ENV: "production",
  SF_LOGIN_URL: MOCK_SF_ORIGIN,
  SF_CONNECTED_APP_CONSUMER_KEY: CLIENT_ID,
  SF_CONNECTED_APP_CONSUMER_SECRET: CLIENT_SECRET,
  SF_OAUTH_REDIRECT_URI: OAUTH_REDIRECT_URI,
  ANTHOS_OAUTH_COOKIE_SECRET: oauthCookieKey,
  ANTHOS_SF_TOKEN_ENC_KEY: sfTokenEncKey,
  // SameSite=None; Secure — the OAuth pre-session cookies must survive the
  // cross-site iframe navigations login → authorize → callback.
  ANTHOS_OAUTH_COOKIE_SAMESITE: "None",
  ANTHOS_OAUTH_COOKIE_SECURE: "true",
  ANTHOS_ROLE_PERMISSION_SETS: JSON.stringify({ [PERMISSION_SET_NAME]: "SPECIALIST" }),
  // Production-shaped frame-ancestors allowlist — the mock SF parent origin
  // explicitly, never `*` (TR-AUTH-5).
  ANTHOS_CSP_FRAME_ANCESTORS: MOCK_SF_ORIGIN,
  // CSRF Origin allowlist — the BFF's own origin only; a mutation from any
  // other Origin is rejected 403 CSRF_ORIGIN_MISMATCH (API §8.6).
  ANTHOS_ALLOWED_ORIGINS: BFF_ORIGIN,
  DEMO_POSTGRES_URL: POSTGRES_URL,
  // P1C-07 cold-path hydration. `selectSalesforceAuth()` picks
  // `SalesforceConnectedAppAuth` only when all four creds are present; the
  // mock SF accepts this bootstrap token on the refresh-token grant so the
  // caseload test never falls through to the absent `sf` CLI keychain.
  SF_CONNECTED_APP_REFRESH_TOKEN: "e2e-bootstrap-refresh-token",
};

export default defineConfig({
  testDir: "apps/web/test/e2e",
  testMatch: /.*\.e2e\.ts$/,
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "pnpm exec tsx apps/web/test/e2e/_support/mock-salesforce.ts",
      url: `${MOCK_SF_ORIGIN}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      command: "pnpm --filter @anthos/web build && pnpm --filter @anthos/web start",
      url: BFF_ORIGIN,
      reuseExistingServer: !process.env.CI,
      timeout: 240_000,
      env: bffEnv,
    },
  ],
});
